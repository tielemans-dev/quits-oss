import { describe, expect, it } from "vitest"
import { ClientRegistrationError, fetchMetadataDocument, registerDynamicClient, resolveClient } from "../clients"
import type { McpOAuthConfig } from "../config"
import { InMemoryMcpOAuthStore } from "../store"
import { chatGptClientMetadata, claudeCodeClientMetadata, fakeMetadataFetcher } from "./fixtures"

const config = { allowClientIdMetadataDocuments: true } as McpOAuthConfig
const now = new Date("2026-10-08T12:00:00Z")

function context(documents: Record<string, unknown>) {
  return { store: new InMemoryMcpOAuthStore(), config, fetchMetadata: fakeMetadataFetcher(documents) }
}

describe("client ID metadata documents", () => {
  it("accepts the Claude Code and ChatGPT documents as public clients", async () => {
    const ctx = context({
      [claudeCodeClientMetadata.client_id]: claudeCodeClientMetadata,
      [chatGptClientMetadata.client_id]: chatGptClientMetadata,
    })
    const claude = await resolveClient(ctx, claudeCodeClientMetadata.client_id, now)
    expect(claude).toMatchObject({ clientName: "Claude Code", registration: "metadata_document" })
    const chatgpt = await resolveClient(ctx, chatGptClientMetadata.client_id, now)
    expect(chatgpt.redirectUris).toEqual(["https://chatgpt.com/connector_platform_oauth_redirect"])

    // Cached until the document's max-age passes.
    await resolveClient(ctx, claudeCodeClientMetadata.client_id, now)
    expect(ctx.fetchMetadata.requested).toHaveLength(2)
  })

  it("refuses a document that names another client_id, lacks fields or allows bad redirects", async () => {
    const url = "https://evil.example/client.json"
    const cases = [
      { ...claudeCodeClientMetadata, client_id: "https://claude.ai/oauth/claude-code-client-metadata" },
      { client_id: url, redirect_uris: ["https://evil.example/cb"] },
      { client_id: url, client_name: "X", redirect_uris: ["cursor://callback"] },
      { client_id: url, client_name: "X", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "client_secret_basic" },
    ]
    for (const document of cases) {
      await expect(resolveClient(context({ [url]: document }), url, now)).rejects.toBeInstanceOf(ClientRegistrationError)
    }
    await expect(resolveClient(context({}), url, now)).rejects.toThrow("404")
    await expect(resolveClient(context({}), "plain-id", now)).rejects.toThrow("Unknown client_id")
  })

  it("refuses to fetch metadata from private or loopback addresses", async () => {
    for (const host of ["https://127.0.0.1/client.json", "https://10.0.0.8/c.json", "https://[::1]/c.json", "https://169.254.169.254/latest"]) {
      await expect(fetchMetadataDocument(new URL(host))).rejects.toThrow("not allowed")
    }
  })

  it("refuses documents larger than 5 KiB", async () => {
    const url = "https://big.example/client.json"
    const ctx = context({ [url]: { ...claudeCodeClientMetadata, client_id: url, padding: "x".repeat(6000) } })
    await expect(resolveClient(ctx, url, now)).rejects.toThrow("too large")
  })
})

describe("dynamic client registration", () => {
  it("registers public clients with acceptable redirects only", async () => {
    const store = new InMemoryMcpOAuthStore()
    const client = await registerDynamicClient(
      store,
      { client_name: "Local test", redirect_uris: ["http://127.0.0.1/callback"], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" },
      now
    )
    expect(client.clientId).toMatch(/^quits_dcr_/)
    expect(await store.getClient(client.clientId)).toEqual(client)

    await expect(registerDynamicClient(store, { redirect_uris: ["http://evil.example/cb"] }, now)).rejects.toThrow("https")
    await expect(
      registerDynamicClient(store, { redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" }, now)
    ).rejects.toThrow("public clients")
    await expect(
      registerDynamicClient(store, { redirect_uris: ["https://a.example/cb"], grant_types: ["client_credentials"] }, now)
    ).rejects.toThrow("grants")
  })
})
