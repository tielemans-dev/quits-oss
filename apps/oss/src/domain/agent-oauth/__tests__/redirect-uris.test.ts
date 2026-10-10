import { describe, expect, it } from "vitest"
import { isAcceptableRedirectUri, isLoopbackOnly, matchRedirectUri } from "../redirect-uris"

describe("redirect URIs", () => {
  it("accepts only https and loopback http redirects", () => {
    expect(isAcceptableRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true)
    expect(isAcceptableRedirectUri("http://127.0.0.1:3118/callback")).toBe(true)
    expect(isAcceptableRedirectUri("http://[::1]/callback")).toBe(true)
    expect(isAcceptableRedirectUri("http://example.com/callback")).toBe(false)
    expect(isAcceptableRedirectUri("cursor://anysphere.cursor-mcp/oauth/callback")).toBe(false)
    expect(isAcceptableRedirectUri("javascript:alert(1)")).toBe(false)
    expect(isAcceptableRedirectUri("https://claude.ai/callback#fragment")).toBe(false)
    expect(isAcceptableRedirectUri("https://user:pass@claude.ai/callback")).toBe(false)
    expect(isAcceptableRedirectUri("not a url")).toBe(false)
  })

  it("matches registered redirects exactly", () => {
    const registered = ["https://chatgpt.com/connector_platform_oauth_redirect"]
    expect(matchRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect", registered)).toBe(true)
    expect(matchRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect/", registered)).toBe(false)
    expect(matchRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect?x=1", registered)).toBe(false)
    expect(matchRedirectUri("https://chatgpt.com.evil.example/connector_platform_oauth_redirect", registered)).toBe(false)
    expect(matchRedirectUri("https://CHATGPT.com/connector_platform_oauth_redirect", registered)).toBe(false)
    expect(matchRedirectUri("https://chatgpt.com:8443/connector_platform_oauth_redirect", registered)).toBe(false)
  })

  it("ignores only the port of a registered loopback redirect", () => {
    const registered = ["http://localhost/callback", "http://127.0.0.1/callback"]
    expect(matchRedirectUri("http://localhost:3118/callback", registered)).toBe(true)
    expect(matchRedirectUri("http://127.0.0.1:52011/callback", registered)).toBe(true)
    expect(matchRedirectUri("http://[::1]:3118/callback", registered)).toBe(false)
    expect(matchRedirectUri("http://localhost:3118/other", registered)).toBe(false)
    expect(matchRedirectUri("http://localhost:3118/callback?next=x", registered)).toBe(false)
    expect(matchRedirectUri("https://localhost:3118/callback", registered)).toBe(false)
  })

  it("flags clients whose only redirects are loopback addresses", () => {
    expect(isLoopbackOnly(["http://localhost/callback"])).toBe(true)
    expect(isLoopbackOnly(["http://localhost/callback", "https://app.example/cb"])).toBe(false)
  })
})
