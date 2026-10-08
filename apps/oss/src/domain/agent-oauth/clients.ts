import { randomBytes } from "node:crypto"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { z } from "zod"
import ipaddr from "ipaddr.js"
import type { McpOAuthConfig } from "./config"
import { isAcceptableRedirectUri } from "./redirect-uris"
import type { McpOAuthStore, RegisteredClient } from "./store"

/**
 * Client identification for the prototype. Two ways are supported, both for public clients only
 * (`token_endpoint_auth_method: none`), which PKCE and refresh-token rotation protect:
 *
 * - Client ID Metadata Documents: the `client_id` is an HTTPS URL that serves the client's metadata.
 *   Claude and ChatGPT both publish one. Preferred by the current MCP authorization spec.
 * - Dynamic Client Registration (RFC 7591): deprecated by the spec but still the fallback for many
 *   clients. It can be turned off with `QUITS_MCP_OAUTH_DYNAMIC_REGISTRATION=false`.
 */

export class ClientRegistrationError extends Error {
  constructor(
    readonly error: "invalid_client_metadata" | "invalid_redirect_uri" | "invalid_client",
    message: string
  ) {
    super(message)
  }
}

const SUPPORTED_GRANTS = new Set(["authorization_code", "refresh_token"])
const METADATA_MAX_BYTES = 5 * 1024
const METADATA_TIMEOUT_MS = 5_000
const METADATA_MIN_CACHE_SECONDS = 5 * 60
const METADATA_MAX_CACHE_SECONDS = 24 * 60 * 60

const clientMetadataSchema = z.object({
  client_name: z.string().trim().min(1).max(100).optional(),
  client_uri: z.string().url().max(500).optional(),
  redirect_uris: z.array(z.string().max(500)).min(1).max(10),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
})

type ClientMetadata = z.infer<typeof clientMetadataSchema>

function validateMetadata(metadata: ClientMetadata) {
  const rejected = metadata.redirect_uris.filter((uri) => !isAcceptableRedirectUri(uri))
  if (rejected.length > 0) {
    throw new ClientRegistrationError(
      "invalid_redirect_uri",
      `Redirect URIs must use https or a loopback http address: ${rejected.join(", ")}`
    )
  }
  const grants = metadata.grant_types ?? ["authorization_code"]
  if (!grants.includes("authorization_code") || grants.some((grant) => !SUPPORTED_GRANTS.has(grant))) {
    throw new ClientRegistrationError(
      "invalid_client_metadata",
      "Only the authorization_code and refresh_token grants are supported"
    )
  }
  if (metadata.response_types && metadata.response_types.some((type) => type !== "code")) {
    throw new ClientRegistrationError("invalid_client_metadata", "Only response_type code is supported")
  }
  // A client that can authenticate as a public client may use this server. Some clients (ChatGPT)
  // prefer private_key_jwt but list `none` among the methods they accept.
  const methods = metadata.token_endpoint_auth_methods_supported ?? [metadata.token_endpoint_auth_method ?? "none"]
  if (metadata.token_endpoint_auth_method !== "none" && !methods.includes("none")) {
    throw new ClientRegistrationError(
      "invalid_client_metadata",
      "Only public clients (token_endpoint_auth_method none) are supported"
    )
  }
  return grants
}

/** RFC 7591 dynamic registration of a public client. */
export async function registerDynamicClient(
  store: McpOAuthStore,
  rawMetadata: unknown,
  now: Date
): Promise<RegisteredClient> {
  const parsed = clientMetadataSchema.safeParse(rawMetadata)
  if (!parsed.success) {
    throw new ClientRegistrationError("invalid_client_metadata", "Client metadata is invalid")
  }
  const grantTypes = validateMetadata(parsed.data)
  const client: RegisteredClient = {
    clientId: `quits_dcr_${randomBytes(18).toString("base64url")}`,
    clientName: parsed.data.client_name ?? "Unnamed MCP client",
    clientUri: parsed.data.client_uri ?? null,
    redirectUris: parsed.data.redirect_uris,
    grantTypes,
    registration: "dynamic",
    createdAt: now,
    expiresAt: null,
  }
  await store.saveClient(client)
  return client
}

export function isMetadataDocumentClientId(clientId: string) {
  try {
    const url = new URL(clientId)
    return url.protocol === "https:" && url.pathname !== "/" && !url.hash
  } catch {
    return false
  }
}

function isPublicAddress(address: string) {
  try {
    // process() normalizes *both* dotted and hexadecimal IPv4-mapped IPv6 before
    // classifying the IPv4 address. URL.hostname canonicalizes to hexadecimal.
    const parsed = ipaddr.process(address)
    if (parsed.range() !== "unicast") return false
    const bytes = parsed.toByteArray()
    // ipaddr.js 1.x does not classify the IPv4 benchmarking block.
    if (parsed.kind() === "ipv4" && bytes[0] === 198 && (bytes[1]! & 0xfe) === 18) return false
    // Conservatively exclude IETF special-purpose and documentation blocks not
    // classified by ipaddr.js 1.x, including IPv6 benchmarking and ORCHID.
    if (parsed instanceof ipaddr.IPv6 && (
      parsed.match(ipaddr.IPv6.parseCIDR("2001::/23")) ||
      parsed.match(ipaddr.IPv6.parseCIDR("3fff::/20"))
    )) return false
    // Only global IPv6 unicast; exclude legacy site-local and translation ranges.
    return parsed.kind() === "ipv4" || (parsed.toByteArray()[0]! & 0xe0) === 0x20
  } catch {
    return false
  }
}

/** Bound unabortable DNS and test transports as well as fetch and body reads. */
function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    if (signal.aborted) abort()
  })
}

/** Fetch without redirects, accepting only public addresses. The caller bounds the body. */
export type MetadataDocumentFetcher = (url: URL, signal?: AbortSignal) => Promise<Response>

export const fetchMetadataDocument: MetadataDocumentFetcher = async (url, signal = AbortSignal.timeout(METADATA_TIMEOUT_MS)) => {
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ClientRegistrationError("invalid_client", "The client metadata host is not allowed")
  }
  const host = url.hostname.replace(/^\[|\]$/g, "")
  const addresses = isIP(host)
    ? [host]
    : (await untilAborted(lookup(host, { all: true }), signal)).map((entry) => entry.address)
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    throw new ClientRegistrationError("invalid_client", "The client metadata host is not allowed")
  }
  signal.throwIfAborted()
  return untilAborted(fetch(url, {
    redirect: "error",
    headers: { accept: "application/json" },
    signal,
  }), signal)
}

async function readMetadata(clientId: string, fetcher: MetadataDocumentFetcher) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("Metadata deadline exceeded")), METADATA_TIMEOUT_MS)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await untilAborted(fetcher(new URL(clientId), controller.signal), controller.signal)
    reader = response.body?.getReader()
    if (!response.ok) {
      throw new ClientRegistrationError("invalid_client", `The client metadata document returned ${response.status}`)
    }
    const chunks: Uint8Array[] = []
    let size = 0
    while (reader) {
      const { done, value } = await untilAborted(reader.read(), controller.signal)
      if (done) break
      size += value.byteLength
      if (size > METADATA_MAX_BYTES) {
        throw new ClientRegistrationError("invalid_client", "The client metadata document is too large")
      }
      chunks.push(value)
    }
    return { response, text: Buffer.concat(chunks, size).toString("utf8") }
  } catch (error) {
    // Do not wait for a hostile peer to acknowledge cancellation.
    void reader?.cancel().catch(() => {})
    controller.abort(error)
    if (error instanceof ClientRegistrationError) throw error
    throw new ClientRegistrationError("invalid_client", "The client metadata document could not be fetched")
  } finally {
    clearTimeout(timeout)
    reader?.releaseLock()
  }
}

function cacheSeconds(response: Response) {
  const maxAge = /max-age=(\d+)/i.exec(response.headers.get("cache-control") ?? "")
  const seconds = maxAge ? Number(maxAge[1]) : METADATA_MIN_CACHE_SECONDS
  return Math.min(Math.max(seconds, METADATA_MIN_CACHE_SECONDS), METADATA_MAX_CACHE_SECONDS)
}

async function loadMetadataDocumentClient(
  clientId: string,
  fetcher: MetadataDocumentFetcher,
  now: Date
): Promise<RegisteredClient> {
  const { response, text } = await readMetadata(clientId, fetcher)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new ClientRegistrationError("invalid_client", "The client metadata document is not JSON")
  }
  if (!body || typeof body !== "object" || (body as { client_id?: unknown }).client_id !== clientId) {
    throw new ClientRegistrationError("invalid_client", "The client metadata document names a different client_id")
  }
  const parsed = clientMetadataSchema.extend({ client_name: z.string().trim().min(1).max(100) }).safeParse(body)
  if (!parsed.success) {
    throw new ClientRegistrationError("invalid_client", "The client metadata document is missing required fields")
  }
  const grantTypes = validateMetadata(parsed.data)
  return {
    clientId,
    clientName: parsed.data.client_name,
    clientUri: parsed.data.client_uri ?? null,
    redirectUris: parsed.data.redirect_uris,
    grantTypes,
    registration: "metadata_document",
    createdAt: now,
    expiresAt: new Date(now.getTime() + cacheSeconds(response) * 1000),
  }
}

/** Resolves a `client_id` from an authorization or token request. */
export async function resolveClient(
  context: { store: McpOAuthStore; config: McpOAuthConfig; fetchMetadata: MetadataDocumentFetcher },
  clientId: string,
  now: Date
): Promise<RegisteredClient> {
  const cached = await context.store.getClient(clientId)
  if (cached && (!cached.expiresAt || cached.expiresAt > now)) {
    return cached
  }
  if (isMetadataDocumentClientId(clientId)) {
    if (!context.config.allowClientIdMetadataDocuments) {
      throw new ClientRegistrationError("invalid_client", "Client ID metadata documents are not enabled")
    }
    const client = await loadMetadataDocumentClient(clientId, context.fetchMetadata, now)
    await context.store.saveClient(client)
    return client
  }
  throw new ClientRegistrationError("invalid_client", "Unknown client_id")
}
