import type { TranslationKey } from "./i18n/catalog"

/** Translated messages for AI drafting failures, by tRPC error code. */
const MESSAGE_KEYS: Record<string, TranslationKey> = {
  UNPROCESSABLE_CONTENT: "invoices.new.ai.error.notAnInvoice",
  TOO_MANY_REQUESTS: "invoices.new.ai.error.busy",
  GATEWAY_TIMEOUT: "invoices.new.ai.error.timeout",
  BAD_GATEWAY: "invoices.new.ai.error.providerFailed",
}

/**
 * The message to show for a failed AI draft request, or `undefined` when the server's own message
 * applies (setup problems such as a missing key or subscription).
 */
export function aiDraftErrorMessageKey(error: unknown): TranslationKey | undefined {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code
  return typeof code === "string" ? MESSAGE_KEYS[code] : undefined
}
