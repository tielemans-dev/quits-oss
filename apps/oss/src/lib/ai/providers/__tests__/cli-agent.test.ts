import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { Writable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetRuntimePlatform, setRuntimePlatform } from "../../../runtime/platform"
import { AiProviderError, type AiCompletionRequest } from "../../provider"
import { agentEnv, createCliAgentProvider } from "../cli-agent"

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock("node:child_process", () => ({ spawn: spawnMock }))

type FakeChild = {
  child: EventEmitter
  stdinWrites: string[]
  kill: ReturnType<typeof vi.fn>
  writeStdout: (chunk: string | Buffer) => void
  writeStderr: (chunk: string) => void
  exit: (code: number | null, signal?: NodeJS.Signals | null) => void
  fail: (error: Error) => void
}

function createFakeChild(): FakeChild {
  const stdinWrites: string[] = []
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      stdinWrites.push(String(chunk))
      callback()
    },
  })
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const kill = vi.fn(() => true)
  const child = new EventEmitter()
  Object.assign(child, { stdin, stdout, stderr, kill })

  return {
    child,
    stdinWrites,
    kill,
    writeStdout: (chunk) => stdout.emit("data", Buffer.from(chunk)),
    writeStderr: (chunk) => stderr.emit("data", Buffer.from(chunk)),
    exit: (code, signal = null) => child.emit("close", code, signal),
    fail: (error) => child.emit("error", error),
  }
}

let lastChild: FakeChild | undefined

function currentChild(): FakeChild {
  if (!lastChild) {
    throw new Error("The local agent was not spawned")
  }
  return lastChild
}

/** Attaches handlers right away so a rejection fired by fake timers is never unhandled. */
function capture<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
}

/** Starts a completion and waits until the agent process has been spawned. */
async function startAgent(request: AiCompletionRequest = REQUEST) {
  const outcome = capture(createCliAgentProvider().complete(request))
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
  return { outcome, child: currentChild() }
}

const REQUEST: AiCompletionRequest = {
  model: "ignored-by-cli-agent",
  messages: [
    { role: "system", content: "Be terse." },
    { role: "user", content: "Draft an invoice for Acme" },
  ],
}

describe("cli agent provider", () => {
  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => {
      lastChild = createFakeChild()
      return lastChild.child
    })
    lastChild = undefined
    vi.stubEnv("QUITS_AI_LOCAL_AGENT_COMMAND", "claude -p --output-format text")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
    resetRuntimePlatform()
  })

  it("has the cli_agent id and no model list", () => {
    const provider = createCliAgentProvider()

    expect(provider.id).toBe("cli_agent")
    expect(provider.listModels).toBeUndefined()
  })

  it("splits the command into argv honouring quotes and spawns without a shell", async () => {
    vi.stubEnv(
      "QUITS_AI_LOCAL_AGENT_COMMAND",
      `tool --name "Acme Agent" 'a b' plain ""`
    )

    const { outcome, child } = await startAgent()
    child.writeStdout("done")
    child.exit(0)

    expect(await outcome).toEqual({ value: "done" })
    expect(spawnMock).toHaveBeenCalledWith(
      "tool",
      ["--name", "Acme Agent", "a b", "plain", ""],
      expect.objectContaining({ shell: false, cwd: tmpdir(), env: agentEnv(process.env) })
    )
  })

  it("writes the prompt to stdin and keeps user text out of argv", async () => {
    const { outcome, child } = await startAgent()
    child.writeStdout("{}")
    child.exit(0)
    await outcome

    expect(child.stdinWrites.join("")).toBe(
      "System:\nBe terse.\n\nUser:\nDraft an invoice for Acme\n\n" +
        "Reply with only the requested output. Do not use any tools or run any commands."
    )
    const [, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(JSON.stringify(args)).not.toContain("Acme")
  })

  it("returns trimmed stdout on success", async () => {
    const { outcome, child } = await startAgent()
    child.writeStdout('  {"items":[]}\n')
    child.exit(0)

    expect(await outcome).toEqual({ value: '{"items":[]}' })
  })

  it("reports a non-zero exit with the exit code and the stderr tail", async () => {
    const { outcome, child } = await startAgent()
    child.writeStderr(`${"x".repeat(600)}not logged in`)
    child.exit(2)

    const result = await outcome
    expect(result).toEqual({
      error: expect.objectContaining({ code: "process_failed" }),
    })
    const message = (result as { error: AiProviderError }).error.message
    expect(message).toContain("code 2")
    expect(message).toContain("not logged in")
    expect(message.length).toBeLessThan(600)
  })

  it("kills the agent with SIGKILL and reports a timeout", async () => {
    vi.useFakeTimers()
    vi.stubEnv("QUITS_AI_LOCAL_AGENT_TIMEOUT_MS", "5000")

    const { outcome, child } = await startAgent()
    await vi.advanceTimersByTimeAsync(5000)

    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
    expect(await outcome).toEqual({
      error: expect.objectContaining({ code: "timeout" }),
    })
  })

  it("reports a missing executable as process_failed naming it", async () => {
    const { outcome, child } = await startAgent()
    child.fail(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }))

    const result = await outcome
    expect(result).toEqual({
      error: expect.objectContaining({ code: "process_failed" }),
    })
    expect((result as { error: AiProviderError }).error.message).toContain('"claude"')
  })

  it("reports blank stdout as empty_response", async () => {
    const { outcome, child } = await startAgent()
    child.writeStdout("  \n")
    child.exit(0)

    expect(await outcome).toEqual({
      error: expect.objectContaining({ code: "empty_response" }),
    })
  })

  it("kills the agent and reports invalid_response when stdout exceeds 1 MiB", async () => {
    const { outcome, child } = await startAgent()
    child.writeStdout(Buffer.alloc(1024 * 1024 + 1, "a").toString("latin1"))

    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
    expect(await outcome).toEqual({
      error: expect.objectContaining({ code: "invalid_response" }),
    })
  })

  it("does not spawn when the command is missing or blank", async () => {
    vi.stubEnv("QUITS_AI_LOCAL_AGENT_COMMAND", "   ")

    const outcome = await capture(createCliAgentProvider().complete(REQUEST))

    expect(outcome).toEqual({
      error: expect.objectContaining({ code: "not_configured" }),
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it("rejects a command with an unclosed quote without spawning", async () => {
    vi.stubEnv("QUITS_AI_LOCAL_AGENT_COMMAND", `claude -p "unterminated`)

    const outcome = await capture(createCliAgentProvider().complete(REQUEST))

    expect(outcome).toEqual({
      error: expect.objectContaining({ code: "not_configured" }),
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it("reads the legacy YAIP_ prefix when no QUITS_ value is set", async () => {
    vi.stubEnv("QUITS_AI_LOCAL_AGENT_COMMAND", undefined as unknown as string)
    vi.stubEnv("YAIP_AI_LOCAL_AGENT_COMMAND", "legacy-agent --json")

    const { outcome, child } = await startAgent()
    child.writeStdout("ok")
    child.exit(0)
    await outcome

    expect(spawnMock).toHaveBeenCalledWith(
      "legacy-agent",
      ["--json"],
      expect.any(Object)
    )
  })

  it("refuses a run beyond the concurrency limit without spawning", async () => {
    vi.stubEnv("QUITS_AI_LOCAL_AGENT_MAX_CONCURRENT", "1")
    const first = await startAgent()

    await expect(createCliAgentProvider().complete(REQUEST)).rejects.toMatchObject({
      code: "busy",
    })
    expect(spawnMock).toHaveBeenCalledTimes(1)

    first.child.writeStdout("done")
    first.child.exit(0)
    expect(await first.outcome).toEqual({ value: "done" })
  })

  it("admits only the limit when requests start in the same tick", async () => {
    vi.stubEnv("QUITS_AI_LOCAL_AGENT_MAX_CONCURRENT", "1")
    const first = capture(createCliAgentProvider().complete(REQUEST))
    const second = capture(createCliAgentProvider().complete(REQUEST))

    expect(await second).toMatchObject({ error: { code: "busy" } })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    currentChild().writeStdout("done")
    currentChild().exit(0)
    expect(await first).toEqual({ value: "done" })
  })

  it("is disabled on the worker runtime and never spawns", async () => {
    setRuntimePlatform({
      id: "test-worker",
      getRuntimeKind: () => "worker",
      getEnv: () => undefined,
      getBinding: () => undefined,
      getPrisma: () => {
        throw new Error("not used")
      },
      getAuthHooks: () => ({}),
    })

    const outcome = await capture(createCliAgentProvider().complete(REQUEST))

    expect(outcome).toEqual({
      error: expect.objectContaining({ code: "disabled" }),
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

describe("agentEnv", () => {
  it("passes only what an agent needs and drops server secrets", () => {
    expect(
      agentEnv({
        HOME: "/home/quits",
        PATH: "/usr/bin",
        LC_ALL: "en_US.UTF-8",
        ANTHROPIC_API_KEY: "sk-ant",
        DATABASE_URL: "postgres://secret",
        BETTER_AUTH_SECRET: "secret",
        QUITS_SECRETS_KEY: "secret",
      })
    ).toEqual({
      HOME: "/home/quits",
      PATH: "/usr/bin",
      LC_ALL: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "sk-ant",
    })
  })
})
