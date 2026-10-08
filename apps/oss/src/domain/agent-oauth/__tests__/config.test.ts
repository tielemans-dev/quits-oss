import { describe, expect, it } from "vitest"
import { readMcpOAuthConfig } from "../config"

describe("MCP sign-in configuration", () => {
  it("is off unless the prototype flag is set", () => {
    expect(readMcpOAuthConfig({ QUITS_APP_ORIGIN: "https://quits.example" }).enabled).toBe(false)
    expect(readMcpOAuthConfig({ QUITS_MCP_OAUTH_PROTOTYPE: "true" }).enabled).toBe(false)
  })

  it("derives issuer, resource and metadata location from the public origin", () => {
    const config = readMcpOAuthConfig({ QUITS_MCP_OAUTH_PROTOTYPE: "true", QUITS_APP_ORIGIN: "https://Quits.Example/app/" })
    expect(config).toMatchObject({
      enabled: true,
      issuer: "https://quits.example",
      resource: "https://quits.example/api/mcp",
      resourceMetadataUrl: "https://quits.example/.well-known/oauth-protected-resource/api/mcp",
      allowDynamicClientRegistration: true,
    })
    expect(
      readMcpOAuthConfig({ YAIP_MCP_OAUTH_PROTOTYPE: "true", BETTER_AUTH_URL: "https://legacy.example", QUITS_MCP_OAUTH_DYNAMIC_REGISTRATION: "false" })
    ).toMatchObject({ issuer: "https://legacy.example", allowDynamicClientRegistration: false })
  })

  it("requires https except on this machine", () => {
    expect(readMcpOAuthConfig({ QUITS_MCP_OAUTH_PROTOTYPE: "true", QUITS_APP_ORIGIN: "http://localhost:3000" }).issuer).toBe(
      "http://localhost:3000"
    )
    expect(() => readMcpOAuthConfig({ QUITS_MCP_OAUTH_PROTOTYPE: "true", QUITS_APP_ORIGIN: "http://quits.example" })).toThrow(
      "https"
    )
  })
})
