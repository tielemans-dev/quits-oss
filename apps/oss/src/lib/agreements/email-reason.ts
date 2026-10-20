import type { TranslationKey } from "../i18n/messages"

/**
 * The last email attempt in the reader's language, read the same way quotes and invoices read it.
 * Only a stored message with no known outcome or code, such as a provider failure, is shown as stored.
 */
export function agreementEmailReasonKey(attempt: { lastEmailAttemptOutcome?: string | null; lastEmailAttemptCode?: string | null }): TranslationKey | null {
  if (attempt.lastEmailAttemptOutcome === "unconfirmed") return "agreements.email.reason.unconfirmed"
  if (attempt.lastEmailAttemptCode === "provider_missing") return "agreements.email.reason.provider_missing"
  if (attempt.lastEmailAttemptCode === "send_failed") return "agreements.email.reason.send_failed"
  if (attempt.lastEmailAttemptOutcome === "sending") return "agreements.email.reason.sending"
  if (attempt.lastEmailAttemptCode === "sent") return "agreements.email.reason.sent"
  return null
}
