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
  if (!target || !target.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(target)) {
    return null
  }
  try {
    const resolved = new URL(target, INTERNAL_BASE)
    if (resolved.origin !== INTERNAL_BASE) {
      return null
    }
    return `${resolved.pathname}${resolved.search}${resolved.hash}`
  } catch {
    return null
  }
}
