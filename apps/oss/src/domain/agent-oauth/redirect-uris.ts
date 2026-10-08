import { isLoopbackUrl } from "./config"

function parse(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/**
 * Whether a client may register this redirect URI. The MCP authorization spec allows only HTTPS
 * and loopback (`http://localhost`, `http://127.0.0.1`, `http://[::1]`) redirects; custom schemes,
 * fragments and credentials in the URI are refused.
 */
export function isAcceptableRedirectUri(value: string): boolean {
  const url = parse(value)
  if (!url || url.hash || value.includes("#") || url.username || url.password) {
    return false
  }
  if (url.protocol === "https:") {
    return true
  }
  return url.protocol === "http:" && isLoopbackUrl(url)
}

/**
 * Matches a redirect URI from an authorization request against the client's registered URIs.
 * Matching is exact string comparison, except that a loopback redirect may use any port
 * (RFC 8252 section 7.3): native clients such as Claude Code listen on a port chosen per sign-in.
 * The host is never interchangeable, so `localhost` and `127.0.0.1` must each be registered.
 */
export function matchRedirectUri(requested: string, registered: readonly string[]): boolean {
  if (!isAcceptableRedirectUri(requested)) {
    return false
  }
  if (registered.includes(requested)) {
    return true
  }
  const url = parse(requested)
  if (!url || url.protocol !== "http:" || !isLoopbackUrl(url)) {
    return false
  }
  return registered.some((candidate) => {
    const allowed = parse(candidate)
    return Boolean(
      allowed &&
        allowed.protocol === "http:" &&
        allowed.hostname === url.hostname &&
        allowed.pathname === url.pathname &&
        allowed.search === url.search
    )
  })
}

/** Only loopback redirects: any local program could be listening, so consent shows a warning. */
export function isLoopbackOnly(redirectUris: readonly string[]) {
  return redirectUris.length > 0 && redirectUris.every((value) => {
    const url = parse(value)
    return Boolean(url && isLoopbackUrl(url))
  })
}
