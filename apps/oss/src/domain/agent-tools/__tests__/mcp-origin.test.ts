import { describe, expect, it } from "vitest"
import { isAllowedMcpOrigin } from "../mcp"

describe("MCP origin validation", () => {
  const env = {
    BETTER_AUTH_URL: "https://app.example.test/",
    QUITS_MCP_ALLOWED_ORIGINS: "https://agents.example.test, https://other.example.test",
  }

  it("allows clients that send no Origin, like CLI and desktop MCP clients", () => {
    expect(isAllowedMcpOrigin(null, env)).toBe(true)
  })

  it("allows the app's own origin and configured origins", () => {
    expect(isAllowedMcpOrigin("https://app.example.test", env)).toBe(true)
    expect(isAllowedMcpOrigin("https://agents.example.test", env)).toBe(true)
  })

  it("rejects other browser origins", () => {
    expect(isAllowedMcpOrigin("https://evil.example", env)).toBe(false)
    expect(isAllowedMcpOrigin("not a url", env)).toBe(false)
  })
})
