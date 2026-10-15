/**
 * Marks a failed send in the `sendError` search param that carries it from "create and send" to
 * the invoice page. The page shows its own translated notice, so no provider text is put in a URL.
 */
export const EMAIL_SEND_FAILED_PARAM = "email_send_failed"

/**
 * The domain codes of a send whose email did not go out: the provider refused or could not be
 * reached, email delivery is not configured, or the email was withdrawn before any request.
 */
const emailSendFailureReasons = new Set([
  "email_provider_refused",
  "email_provider_unreachable",
  "email_unavailable",
  "email_not_sent",
])

function errorData(error: unknown) {
  return (error as { data?: { reason?: unknown; code?: unknown } } | null)?.data
}

/** Whether a failed send or resend mutation failed at the email step (the document itself is saved). */
export function isEmailSendFailure(error: unknown) {
  const reason = errorData(error)?.reason
  return typeof reason === "string" && emailSendFailureReasons.has(reason)
}

/**
 * Whether the server failed without a refusal the app wrote: an unexpected error, whose message is
 * for the logs, not for the user. Refusals with a domain reason (or none, like a local error) pass.
 */
export function isUnexpectedFailure(error: unknown) {
  const data = errorData(error)
  return data?.code === "INTERNAL_SERVER_ERROR" && !data.reason
}
