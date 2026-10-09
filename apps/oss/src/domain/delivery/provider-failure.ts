import { z } from "zod"

/** Safe classifications only: never transport a provider's free-form error or provider code. */
export const emailProviderFailureCodeSchema = z.enum(["email_provider_refused", "email_provider_unreachable"])
export type EmailProviderFailureCode = z.infer<typeof emailProviderFailureCodeSchema>

export function emailProviderFailureMessage(code: EmailProviderFailureCode = "email_provider_refused") {
  return code === "email_provider_unreachable"
    ? "The email provider could not be reached. Check the email configuration."
    : "The email provider refused the email. Check the email configuration."
}

/** Public document reads must not repeat provider text persisted before delivery sanitizing. */
export function sanitizeDocumentEmailAttempt<T extends object>(document: T): T {
  if (!("lastEmailAttemptOutcome" in document) || document.lastEmailAttemptOutcome !== "failed") return document
  const code = "lastEmailAttemptCode" in document ? document.lastEmailAttemptCode : null
  const message = "lastEmailAttemptMessage" in document ? document.lastEmailAttemptMessage : null
  const unreachable = code === "email_provider_unreachable" || message === emailProviderFailureMessage("email_provider_unreachable")
  return { ...document, lastEmailAttemptMessage: emailProviderFailureMessage(unreachable ? "email_provider_unreachable" : "email_provider_refused") }
}
