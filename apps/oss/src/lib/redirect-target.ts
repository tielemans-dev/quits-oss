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

/**
 * Accepts only same-site absolute paths (e.g. `/invoices/1?tab=a`), rejecting
 * protocol-relative (`//host`) and absolute URLs so redirects cannot leave the app.
 */
export function toInternalRedirectPath(target: string | undefined): string | null {
  if (!target || !target.startsWith("/") || target.startsWith("//") || target.startsWith("/\\")) {
    return null
  }

  return target
}
