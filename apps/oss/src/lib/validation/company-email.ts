import type { TranslationKey } from "../i18n/catalog"

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The message key for a company email that blocks onboarding, or `null` when it is fine. */
export function companyEmailIssue(value: string): Extract<TranslationKey, "validation.email.required" | "validation.email.invalid"> | null {
  const email = value.trim()
  if (!email) return "validation.email.required"
  return EMAIL_PATTERN.test(email) ? null : "validation.email.invalid"
}
