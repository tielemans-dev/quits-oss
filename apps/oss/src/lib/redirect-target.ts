export function normalizeHostedNext(
  next: string | undefined,
  appOrigin: string
): string {
  const fallback = `${appOrigin.replace(/\/$/, "")}/`
  if (!next) return fallback

  try {
    const parsed = new URL(next)
    const allowed = new URL(appOrigin)
    if (parsed.origin !== allowed.origin) return fallback
    return parsed.toString()
  } catch {
    return fallback
  }
}

const INTERNAL_BASE = "http://internal.invalid"

/**
 * Accepts only same-site absolute paths (e.g. `/invoices/1?tab=a`), rejecting protocol-relative
 * (`//host`) and absolute URLs so redirects cannot leave the app. The path is checked the way a
 * browser resolves it: browsers drop tabs and newlines and read `\` as `/`, so `/\t/evil.example`
 * would otherwise become `//evil.example`. Returns the path as the browser would resolve it.
 */
export function toInternalRedirectPath(target: string | undefined): string | null {
  const hasControlOrBackslash = [...(target ?? "")].some((char) => {
    const code = char.charCodeAt(0)
    return code < 0x20 || code === 0x7f || char === "\\"
  })
  if (!target || !target.startsWith("/") || target.startsWith("//") || hasControlOrBackslash) {
    return null
  }
  try {
    const resolved = new URL(target, INTERNAL_BASE)
    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`
    // A path that resolves to `//…` (e.g. `/x/..//evil.example`) is protocol-relative wherever it
    // is used next, so it is rejected as well; accepted paths stay unchanged when checked again.
    if (resolved.origin !== INTERNAL_BASE || path.startsWith("//")) {
      return null
    }
    return path
  } catch {
    return null
  }
}
