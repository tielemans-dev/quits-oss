import type {
  EmailDeliveryAttemptRecord,
  EmailDeliveryAttemptSnapshot,
  EmailDeliveryOutcome,
  EmailDeliveryRuntimeStatus,
} from "@quits/contracts/email"

export type { EmailDeliveryRuntimeStatus }

export function createEmailDeliveryAttempt(input: {
  at?: Date
  outcome: EmailDeliveryOutcome
  code: string
  message: string
}): EmailDeliveryAttemptRecord {
  return {
    lastEmailAttemptAt: input.at ?? new Date(),
    lastEmailAttemptOutcome: input.outcome,
    lastEmailAttemptCode: input.code,
    lastEmailAttemptMessage: input.message,
  }
}

/**
 * The last delivery attempt of a document, or `null` when it is incomplete. Generic over the
 * outcome so the UI can also read outcomes it knows about before the shared contract does.
 */
export function readEmailDeliveryAttempt<TOutcome extends string = EmailDeliveryOutcome>(
  input: Omit<EmailDeliveryAttemptSnapshot, "lastEmailAttemptOutcome"> & {
    lastEmailAttemptOutcome: TOutcome | null
  }
): (Omit<EmailDeliveryAttemptRecord, "lastEmailAttemptOutcome"> & { lastEmailAttemptOutcome: TOutcome }) | null {
  if (
    !input.lastEmailAttemptAt ||
    !input.lastEmailAttemptOutcome ||
    !input.lastEmailAttemptCode ||
    !input.lastEmailAttemptMessage
  ) {
    return null
  }

  return {
    lastEmailAttemptAt: input.lastEmailAttemptAt,
    lastEmailAttemptOutcome: input.lastEmailAttemptOutcome,
    lastEmailAttemptCode: input.lastEmailAttemptCode,
    lastEmailAttemptMessage: input.lastEmailAttemptMessage,
  }
}

export function getEmailDeliveryRuntimeStatus(input: {
  managed: boolean
  resendApiKey?: string | null
  fromEmail?: string | null
}): EmailDeliveryRuntimeStatus {
  const hasResendApiKey = Boolean(input.resendApiKey?.trim())
  const hasFromEmail = Boolean(input.fromEmail?.trim())
  const configured = hasResendApiKey && hasFromEmail
  const available = configured
  const sender = input.fromEmail?.trim() || "noreply@yaip.app"
  const missing = input.managed
    ? []
    : [
        ...(hasFromEmail ? [] : ["FROM_EMAIL"]),
        ...(hasResendApiKey ? [] : ["RESEND_API_KEY"]),
      ]

  return {
    managed: input.managed,
    configured,
    available,
    sender,
    missing,
    status: input.managed
      ? available
        ? "managed"
        : "managed_unavailable"
      : available
        ? "configured"
        : "missing_configuration",
  }
}
