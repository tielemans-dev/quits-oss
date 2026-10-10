import { readBooleanEnv, readProductEnv, resolveUrlOrigin } from "@quits/shared/runtimeEnv"

/**
 * PROTOTYPE (issue #31). Sign-in authorization for MCP clients is off unless an operator sets
 * `QUITS_MCP_OAUTH_PROTOTYPE=true`. While it is off, `/api/mcp` accepts only agent keys, exactly as
 * before, and none of the OAuth endpoints answer.
 */
export type McpOAuthConfig = {
  enabled: boolean
  /** Authorization server issuer identifier (RFC 8414). No trailing slash. */
  issuer: string
  /** Canonical URI of the MCP server (RFC 8707 / RFC 9728 `resource`). */
  resource: string
  /** Where clients find the protected resource metadata for `resource`. */
  resourceMetadataUrl: string
  accessTokenTtlSeconds: number
  refreshTokenIdleTtlSeconds: number
  authorizationCodeTtlSeconds: number
  consentRequestTtlSeconds: number
  allowDynamicClientRegistration: boolean
  allowClientIdMetadataDocuments: boolean
}

export const MCP_PATH = "/api/mcp"
export const OAUTH_BASE_PATH = "/api/mcp/oauth"
export const CONSENT_PATH = "/oauth/consent"

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

export function isLoopbackUrl(url: URL) {
  return LOOPBACK_HOSTS.has(url.hostname)
}

function requireSecureOrigin(origin: string, name: string) {
  const url = new URL(origin)
  // OAuth 2.1 and the MCP authorization spec require HTTPS. Plain HTTP is accepted only for a
  // server on this machine, so a local proof of connection can run without certificates.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackUrl(url))) {
    throw new Error(`${name} must use https (http is allowed only for localhost)`)
  }
  return url.origin
}

export function readMcpOAuthConfig(env: Record<string, string | undefined> = process.env): McpOAuthConfig {
  const enabled = readBooleanEnv(readProductEnv(env, "MCP_OAUTH_PROTOTYPE"), false)
  const appOrigin =
    resolveUrlOrigin(readProductEnv(env, "MCP_OAUTH_ISSUER")) ??
    resolveUrlOrigin(readProductEnv(env, "APP_ORIGIN")) ??
    resolveUrlOrigin(env.BETTER_AUTH_URL)

  if (!enabled || !appOrigin) {
    return {
      enabled: false,
      issuer: "",
      resource: "",
      resourceMetadataUrl: "",
      accessTokenTtlSeconds: 0,
      refreshTokenIdleTtlSeconds: 0,
      authorizationCodeTtlSeconds: 0,
      consentRequestTtlSeconds: 0,
      allowDynamicClientRegistration: false,
      allowClientIdMetadataDocuments: false,
    }
  }

  const issuer = requireSecureOrigin(appOrigin, "QUITS_MCP_OAUTH_ISSUER")
  const resource = `${issuer}${MCP_PATH}`
  return {
    enabled: true,
    issuer,
    resource,
    resourceMetadataUrl: `${issuer}/.well-known/oauth-protected-resource${MCP_PATH}`,
    accessTokenTtlSeconds: 15 * 60,
    refreshTokenIdleTtlSeconds: 30 * 24 * 60 * 60,
    authorizationCodeTtlSeconds: 5 * 60,
    consentRequestTtlSeconds: 15 * 60,
    allowDynamicClientRegistration: readBooleanEnv(readProductEnv(env, "MCP_OAUTH_DYNAMIC_REGISTRATION"), true),
    allowClientIdMetadataDocuments: readBooleanEnv(readProductEnv(env, "MCP_OAUTH_CLIENT_METADATA_DOCUMENTS"), true),
  }
}
