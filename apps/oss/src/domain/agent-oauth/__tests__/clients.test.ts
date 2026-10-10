import { afterEach, describe, expect, it, vi } from "vitest"
import { lookup } from "node:dns/promises"
vi.mock("node:dns/promises", async () => {
  const actual = await vi.importActual<typeof import("node:dns/promises")>("node:dns/promises")
  return { ...actual, lookup: vi.fn(actual.lookup) }
})
import { ClientRegistrationError, fetchMetadataDocument, registerDynamicClient, resolveClient } from "../clients"
import type { McpOAuthConfig } from "../config"
import { InMemoryMcpOAuthStore } from "../store"
import { chatGptClientMetadata, claudeCodeClientMetadata, fakeMetadataFetcher } from "./fixtures"

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

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

  it("blocks canonicalized private IPv4-mapped IPv6 and other non-public addresses before fetch", async () => {
    const outbound = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"))
    for (const host of [
      "127.0.0.1", "10.0.0.8", "169.254.169.254", "[::1]",
      "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[0:0:0:0:0:ffff:a00:8]",
      "[::ffff:169.254.169.254]", "[::ffff:c0a8:1]", "[::ffff:ac10:1]",
      "[fc00::1]", "[fe80::1]", "[ff02::1]", "[2001:db8::1]", "[2001:2::1]", "[2001:20::1]", "[3fff::1]", "[fec0::1]",
      "192.0.2.1", "198.18.0.1", "100.64.0.1", "240.0.0.1", "0.0.0.0",
      "[64:ff9b::7f00:1]", "[2002:7f00:1::]",
    ]) {
      await expect(fetchMetadataDocument(new URL(`https://${host}/client.json`)), host).rejects.toThrow("not allowed")
    }
    expect(outbound).not.toHaveBeenCalled()
  })

  it("allows public IPv4, IPv6 and mapped public IPv4", async () => {
    const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"))
    for (const host of ["8.8.8.8", "[2606:4700:4700::1111]", "[::ffff:808:808]"]) {
      await fetchMetadataDocument(new URL(`https://${host}/client.json`))
    }
    expect(outbound).toHaveBeenCalledTimes(3)
    expect(outbound.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" })
  })

  it("rejects mixed public and private DNS answers before fetch", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }, { address: "::ffff:7f00:1", family: 6 }] as never)
    const outbound = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"))
    await expect(fetchMetadataDocument(new URL("https://mixed.example.test/client.json"))).rejects.toThrow("not allowed")
    expect(outbound).not.toHaveBeenCalled()
  })

  it("times out stalled DNS and never fetches when that lookup later completes", async () => {
    vi.useFakeTimers()
    let finish!: (value: unknown) => void
    vi.mocked(lookup).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }) as never)
    const outbound = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"))
    const pending = expect(resolveClient({ ...context({}), fetchMetadata: fetchMetadataDocument }, "https://slow.example.test/client.json", now)).rejects.toThrow("could not be fetched")
    await vi.advanceTimersByTimeAsync(5001)
    await pending
    finish([{ address: "8.8.8.8", family: 4 }])
    await vi.advanceTimersByTimeAsync(1)
    expect(outbound).not.toHaveBeenCalled()
  })

  it("uses a single deadline across fetch and body consumption", async () => {
    vi.useFakeTimers()
    const cancelled = vi.fn()
    const fetchMetadata = async () => {
      await new Promise((resolve) => setTimeout(resolve, 4000))
      return new Response(new ReadableStream({ cancel: cancelled }))
    }
    const pending = expect(resolveClient({ ...context({}), fetchMetadata }, "https://example.test/client.json", now)).rejects.toThrow("could not be fetched")
    await vi.advanceTimersByTimeAsync(5001)
    await pending
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it("cancels a chunked metadata body as soon as it exceeds 5 KiB", async () => {
    let chunksRead = 0
    const cancelled = vi.fn()
    const fetchMetadata = async () => new Response(new ReadableStream({
      pull(controller) {
        if (chunksRead === 8) return controller.close()
        chunksRead++
        controller.enqueue(new Uint8Array(4096).fill(120))
      },
      cancel: cancelled,
    }, { highWaterMark: 0 }))
    await expect(resolveClient({ ...context({}), fetchMetadata }, "https://example.test/client.json", now)).rejects.toThrow("too large")
    expect(chunksRead).toBe(2)
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it("bounds the whole metadata operation, including a stalled response body", async () => {
    vi.useFakeTimers()
    const cancelled = vi.fn()
    const fetchMetadata = async () => new Response(new ReadableStream({ cancel: cancelled }))
    const pending = expect(resolveClient({ ...context({}), fetchMetadata }, "https://example.test/client.json", now)).rejects.toThrow("could not be fetched")
    await vi.advanceTimersByTimeAsync(5001)
    await pending
    expect(cancelled).toHaveBeenCalledOnce()
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
