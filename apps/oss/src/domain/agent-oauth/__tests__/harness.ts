import { createHash, randomBytes } from "node:crypto"
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import type { UserActor } from "../../actor"
import { handleMcpRequest } from "../../agent-tools/mcp"
import type { McpOAuthConfig } from "../config"
import {
  handleAuthorizationServerMetadataRequest,
  handleOAuthEndpointRequest,
  handleProtectedResourceMetadataRequest,
} from "../http"
import { decideConsent, type ConsentDecision, type McpOAuthContext } from "../server"
import { InMemoryMcpOAuthStore } from "../store"
import { chatGptClientMetadata, claudeCodeClientMetadata, fakeMetadataFetcher } from "./fixtures"

/**
 * A local Quits server for MCP authorization tests: routes requests by path to the same handlers
 * the app's routes call, with no network. Client metadata documents come from fixtures.
 */
export const ISSUER = "https://quits.test"
export const MCP_URL = `${ISSUER}/api/mcp`

export function oauthConfig(overrides: Partial<McpOAuthConfig> = {}): McpOAuthConfig {
  return {
    enabled: true,
    issuer: ISSUER,
    resource: MCP_URL,
    resourceMetadataUrl: `${ISSUER}/.well-known/oauth-protected-resource/api/mcp`,
    accessTokenTtlSeconds: 900,
    refreshTokenIdleTtlSeconds: 30 * 24 * 3600,
    authorizationCodeTtlSeconds: 300,
    consentRequestTtlSeconds: 900,
    allowDynamicClientRegistration: true,
    allowClientIdMetadataDocuments: true,
    ...overrides,
  }
}

export function testOAuthContext(overrides: Partial<McpOAuthConfig> = {}): McpOAuthContext & { clock: { now: Date } } {
  const clock = { now: new Date() }
  return {
    config: oauthConfig(overrides),
    store: new InMemoryMcpOAuthStore(),
    fetchMetadata: fakeMetadataFetcher({
      [claudeCodeClientMetadata.client_id]: claudeCodeClientMetadata,
      [chatGptClientMetadata.client_id]: chatGptClientMetadata,
    }),
    now: () => clock.now,
    clock,
  }
}

/** Every request a client makes to the local server goes through here. */
export async function appFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request && !init ? input : new Request(input, init)
  const url = new URL(request.url)
  if (url.origin !== ISSUER) {
    return new Response("unexpected host", { status: 502 })
  }
  if (url.pathname === "/api/mcp") return handleMcpRequest(request)
  if (url.pathname === "/.well-known/oauth-protected-resource/api/mcp" || url.pathname === "/.well-known/oauth-protected-resource") {
    return handleProtectedResourceMetadataRequest()
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") return handleAuthorizationServerMetadataRequest()
  if (url.pathname.startsWith("/api/mcp/oauth/")) {
    return handleOAuthEndpointRequest(request, url.pathname.slice("/api/mcp/oauth/".length))
  }
  return new Response("not found", { status: 404 })
}

/**
 * Plays the browser: opens the authorization URL, lands on the consent page and has the signed-in
 * person decide, then returns the URL the browser is sent back to.
 */
export async function authorizeInBrowser(
  context: McpOAuthContext,
  authorizationUrl: URL | string,
  user: UserActor,
  decision: ConsentDecision
): Promise<URL> {
  const response = await appFetch(new Request(authorizationUrl))
  if (response.status !== 302) {
    throw new Error(`authorize answered ${response.status}: ${await response.text()}`)
  }
  const consentUrl = new URL(response.headers.get("location")!)
  if (consentUrl.origin !== ISSUER || consentUrl.pathname !== "/oauth/consent") {
    // An error redirect straight back to the client.
    return consentUrl
  }
  const { redirectTo } = await decideConsent(context, user, consentUrl.searchParams.get("request")!, decision)
  return new URL(redirectTo)
}

/** An OAuth client provider for the MCP TypeScript SDK client, holding everything in memory. */
export class MemoryOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null
  private info: OAuthClientInformationMixed | undefined
  private storedTokens: OAuthTokens | undefined
  private verifier = ""
  readonly expectedState = randomBytes(16).toString("base64url")

  constructor(
    private readonly options: { redirectUrl: string; clientName: string; clientMetadataUrl?: string }
  ) {}

  get redirectUrl() {
    return this.options.redirectUrl
  }
  get clientMetadataUrl() {
    return this.options.clientMetadataUrl
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.options.clientName,
      redirect_uris: [this.options.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }
  }
  state() {
    return this.expectedState
  }
  clientInformation() {
    return this.info
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info
  }
  tokens() {
    return this.storedTokens
  }
  saveTokens(tokens: OAuthTokens) {
    this.storedTokens = tokens
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier
  }
  codeVerifier() {
    return this.verifier
  }
}

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url")
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }
}

/** Parses a `WWW-Authenticate: Bearer a="b", c="d"` header. */
export function parseChallenge(header: string | null) {
  const params: Record<string, string> = {}
  for (const match of (header ?? "").matchAll(/(\w+)="([^"]*)"/g)) {
    params[match[1]!] = match[2]!
  }
  return params
}

export function tokenRequest(params: Record<string, string>) {
  return appFetch(`${ISSUER}/api/mcp/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  })
}

let rpcId = 0

/** Sends one JSON-RPC message to the MCP endpoint without the SDK, as a raw HTTP client would. */
export async function rawMcp(token: string | null, method: string, params: Record<string, unknown> = {}) {
  const response = await appFetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  })
  const body = response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text()
  return { response, body }
}

export const initializeParams = {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "raw-http-harness", version: "1.0.0" },
}

/** Calls a tool and returns the parsed JSON payload of its first text block. */
export async function rawToolCall(token: string, name: string, args: Record<string, unknown> = {}) {
  const { response, body } = await rawMcp(token, "tools/call", { name, arguments: args })
  if (response.status !== 200) return { status: response.status, response, isError: true, value: body }
  const result = (body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result
  let value: unknown = result.content[0]?.text
  try {
    value = JSON.parse(String(value))
  } catch {
    // Plain-text protocol errors.
  }
  return { status: 200, response, isError: Boolean(result.isError), value: value as any }
}
