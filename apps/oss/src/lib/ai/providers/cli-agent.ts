import { readProductEnv } from "@quits/shared/runtimeEnv"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { getRuntimeEnv, getRuntimePlatform } from "../../runtime/platform"
import {
  AiProviderError,
  type AiChatMessage,
  type AiCompletionRequest,
  type AiProvider,
} from "../provider"

const PROVIDER_ID = "cli_agent"
const DEFAULT_TIMEOUT_MS = 120_000
const MIN_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 600_000
const MAX_STDOUT_BYTES = 1024 * 1024
const STDERR_TAIL_CHARS = 500
const FINAL_INSTRUCTION =
  "Reply with only the requested output. Do not use any tools or run any commands."

/**
 * Runs a local CLI agent (for example `claude -p` or `codex exec`) that the operator installed and
 * logged in on the server. The command comes only from the operator's environment, never from
 * organisation settings, and user text is written to the agent's stdin, never into argv.
 *
 * `node:child_process` is imported lazily so this module can be loaded by the worker build, which
 * has no child processes; the provider reports `disabled` there.
 */
export function createCliAgentProvider(): AiProvider {
  return {
    id: PROVIDER_ID,
    complete: runLocalAgent,
  }
}

async function runLocalAgent(request: AiCompletionRequest): Promise<string> {
  if (getRuntimePlatform().getRuntimeKind() !== "node") {
    throw new AiProviderError({
      code: "disabled",
      providerId: PROVIDER_ID,
      message: "The local agent needs a Node.js server runtime",
    })
  }

  const env = getRuntimeEnv()
  const commandLine = readProductEnv(env, "AI_LOCAL_AGENT_COMMAND")?.trim()
  if (!commandLine) {
    throw new AiProviderError({
      code: "not_configured",
      providerId: PROVIDER_ID,
      message: "Set AI_LOCAL_AGENT_COMMAND on the server before using the local agent",
    })
  }

  const [executable, ...args] = splitCommandLine(commandLine)
  if (!executable) {
    throw new AiProviderError({
      code: "not_configured",
      providerId: PROVIDER_ID,
      message: "AI_LOCAL_AGENT_COMMAND is empty",
    })
  }

  const timeoutMs = readTimeoutMs(readProductEnv(env, "AI_LOCAL_AGENT_TIMEOUT_MS"))
  // `request.model` is ignored: the CLI chooses its own model. `temperature` is not supported.
  const prompt = buildPrompt(request.messages)

  const [{ spawn }, { tmpdir }] = await Promise.all([
    import("node:child_process"),
    import("node:os"),
  ])

  return collectAgentOutput({
    spawn,
    executable,
    args,
    prompt,
    timeoutMs,
    cwd: tmpdir(),
  })
}

type SpawnFunction = (
  command: string,
  args: string[],
  options: {
    shell: false
    cwd: string
    env: NodeJS.ProcessEnv
    stdio: ["pipe", "pipe", "pipe"]
    windowsHide: true
  }
) => ChildProcessWithoutNullStreams

// The prompt includes text written by users, so the agent must not see the server's own
// secrets (database URL, auth and encryption keys). Pass only what a CLI agent needs to
// find its binary, its login and the locale, plus the agents' own configuration variables.
const AGENT_ENV_NAMES = new Set(["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "LANG"])
const AGENT_ENV_PREFIXES = ["LC_", "XDG_", "ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_"]

export function agentEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      (AGENT_ENV_NAMES.has(name) || AGENT_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)))
    ) {
      env[name] = value
    }
  }
  return env
}

function collectAgentOutput(input: {
  spawn: SpawnFunction
  executable: string
  args: string[]
  prompt: string
  timeoutMs: number
  cwd: string
}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = input.spawn(input.executable, input.args, {
        shell: false,
        cwd: input.cwd,
        env: agentEnv(process.env),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (error) {
      reject(startFailure(input.executable, error))
      return
    }

    const stdoutChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrTail = ""
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const settle = (action: () => void) => {
      if (settled) {
        return
      }
      settled = true
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      action()
    }

    timer = setTimeout(() => {
      settle(() => {
        child.kill("SIGKILL")
        reject(
          new AiProviderError({
            code: "timeout",
            providerId: PROVIDER_ID,
            message: `The local agent did not finish within ${Math.round(input.timeoutMs / 1000)} seconds`,
          })
        )
      })
    }, input.timeoutMs)

    // The agent may exit before reading its prompt; the exit status reports that failure instead.
    child.stdin.on("error", () => {})
    child.stdin.end(input.prompt)

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) {
        return
      }
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        settle(() => {
          child.kill("SIGKILL")
          reject(
            new AiProviderError({
              code: "invalid_response",
              providerId: PROVIDER_ID,
              message: "The local agent wrote more than 1 MiB of output",
            })
          )
        })
        return
      }
      stdoutChunks.push(chunk)
    })

    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS)
    })

    child.once("error", (error) => {
      settle(() => reject(startFailure(input.executable, error)))
    })

    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      settle(() => {
        if (code !== 0) {
          const status = code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`
          const detail = stderrTail.trim()
          reject(
            new AiProviderError({
              code: "process_failed",
              providerId: PROVIDER_ID,
              message: `The local agent exited with ${status}${detail ? `: ${detail}` : ""}`,
            })
          )
          return
        }

        const output = Buffer.concat(stdoutChunks).toString("utf8").trim()
        if (!output) {
          reject(
            new AiProviderError({
              code: "empty_response",
              providerId: PROVIDER_ID,
              message: "The local agent returned no output",
            })
          )
          return
        }
        resolve(output)
      })
    })
  })
}

function startFailure(executable: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error)
  return new AiProviderError({
    code: "process_failed",
    providerId: PROVIDER_ID,
    message: `Could not start the local agent "${executable}": ${detail}`,
    cause: error,
  })
}

function buildPrompt(messages: AiChatMessage[]) {
  const sections = messages.map(
    (message) => `${message.role === "system" ? "System" : "User"}:\n${message.content}`
  )
  sections.push(FINAL_INSTRUCTION)
  return sections.join("\n\n")
}

function readTimeoutMs(raw: string | undefined) {
  const trimmed = raw?.trim()
  if (!trimmed) {
    return DEFAULT_TIMEOUT_MS
  }
  const value = Number(trimmed)
  if (!Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)))
}

/**
 * Splits a command line into argv on whitespace. Single and double quotes group words; there are
 * no escape sequences and no shell expansion, because the command is spawned without a shell.
 */
function splitCommandLine(commandLine: string): string[] {
  const parts: string[] = []
  let current = ""
  let inToken = false
  let quote: "'" | '"' | null = null

  for (const char of commandLine) {
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      inToken = true
      continue
    }

    if (/\s/.test(char)) {
      if (inToken) {
        parts.push(current)
        current = ""
        inToken = false
      }
      continue
    }

    current += char
    inToken = true
  }

  if (quote) {
    throw new AiProviderError({
      code: "not_configured",
      providerId: PROVIDER_ID,
      message: "AI_LOCAL_AGENT_COMMAND has an unclosed quote",
    })
  }
  if (inToken) {
    parts.push(current)
  }
  return parts
}
