import type { TranslationKey } from "../../../lib/i18n/catalog"

/**
 * The message for a failed contact save. The server names a rejected phone number by its issue
 * path, so it gets a translated message; other failures keep the server's text or the fallback.
 */
export function contactSaveError(error: unknown, t: (key: TranslationKey) => string, fallback: TranslationKey) {
  const issues = (error as { data?: { issues?: unknown } } | null)?.data?.issues
  if (Array.isArray(issues) && issues.some((issue) => (issue as { path?: unknown } | null)?.path === "phone")) {
    return t("validation.phone.invalid")
  }
  return error instanceof Error ? error.message : t(fallback)
}
