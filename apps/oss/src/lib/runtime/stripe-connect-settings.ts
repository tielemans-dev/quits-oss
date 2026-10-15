/** Settings actions the hosted runtime may register. This module does not call Stripe. */
export const stripeConnectSettingsActions = ["connect", "resume", "fix", "disconnect"] as const

export type StripeConnectSettingsAction = (typeof stripeConnectSettingsActions)[number]

/**
 * Hosted Connect behavior for settings. Absent until the runtime registers one.
 * `url` is an https address the browser may open; this layer does not create it.
 */
export type StripeConnectSettingsHandler = {
  run: (
    action: StripeConnectSettingsAction,
    input: { organizationId: string }
  ) => Promise<{ url?: string | null } | void>
}

/** Opens an https URL returned by the hosted handler. */
export function followStripeConnectUrl(url: string) {
  window.location.assign(url)
}

/** Only an https URL from the registered handler is safe to open. */
export function stripeConnectRedirectUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.length === 0) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null
    return parsed.toString()
  } catch {
    return null
  }
}
