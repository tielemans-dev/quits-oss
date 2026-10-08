import { afterEach, describe, expect, it, vi } from "vitest"
import { createCliAgentProvider } from "../cli-agent"

// Uses a real subprocess, unlike cli-agent.test.ts, to check process-group cleanup.
describe.skipIf(process.platform === "win32")("cli agent process cleanup", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("returns once the agent exits even if a leftover process holds its stdout", async () => {
    // The background `sleep` inherits stdout, so `close` would wait for it without the group kill.
    vi.stubEnv("QUITS_AI_LOCAL_AGENT_COMMAND", `sh -c "printf done; sleep 30 &"`)
    vi.stubEnv("QUITS_AI_LOCAL_AGENT_TIMEOUT_MS", "20000")

    const started = Date.now()
    const output = await createCliAgentProvider().complete({
      model: "ignored",
      messages: [{ role: "user", content: "hi" }],
    })

    expect(output).toBe("done")
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 15_000)
})
