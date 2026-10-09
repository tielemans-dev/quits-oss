import { z } from "zod"

/** Safe classifications only: never transport a provider's free-form error or provider code. */
export const emailProviderFailureCodeSchema = z.enum(["email_provider_refused", "email_provider_unreachable"])
export type EmailProviderFailureCode = z.infer<typeof emailProviderFailureCodeSchema>

export function emailProviderFailureMessage(code: EmailProviderFailureCode = "email_provider_refused") {
  return code === "email_provider_unreachable"
    ? "The email provider could not be reached. Check the email configuration."
    : "The email provider refused the email. Check the email configuration."
}

export const NOT_CONFIGURED_MESSAGE = "Email delivery is not configured, so nothing was sent. Send it again once it is."
export const NEVER_SENT_MESSAGE = "The email could not be sent, and nothing was delivered. Send it again."
const AUTO_SEND_PREFIX = "Automatic sending failed: "
const APP_FAILURE_MESSAGES = new Set([
  NEVER_SENT_MESSAGE, NOT_CONFIGURED_MESSAGE,
  "Contact has no email address", "Email delivery is not configured", "Only draft invoices can be sent",
  emailProviderFailureMessage(), emailProviderFailureMessage("email_provider_unreachable"),
])

/** Public document reads must not repeat provider text persisted before delivery sanitizing. */
export function sanitizeDocumentEmailAttempt<T extends object>(document: T): T {
  if (!("lastEmailAttemptOutcome" in document) || document.lastEmailAttemptOutcome !== "failed") return document
  const code = "lastEmailAttemptCode" in document ? document.lastEmailAttemptCode : null
  const message = "lastEmailAttemptMessage" in document ? document.lastEmailAttemptMessage : null
  // A prefix alone does not make its suffix safe: old automatic-send errors could contain
  // provider responses. Preserve exact app-authored reasons, never arbitrary text after it.
  if (typeof message === "string" && APP_FAILURE_MESSAGES.has(message)) return document
  const automatic = typeof message === "string" && message.startsWith(AUTO_SEND_PREFIX)
  if (automatic && APP_FAILURE_MESSAGES.has(message.slice(AUTO_SEND_PREFIX.length))) return document
  const unreachable = code === "email_provider_unreachable" || message === emailProviderFailureMessage("email_provider_unreachable")
  return { ...document, lastEmailAttemptMessage: `${automatic ? AUTO_SEND_PREFIX : ""}${emailProviderFailureMessage(unreachable ? "email_provider_unreachable" : "email_provider_refused")}` }
}
