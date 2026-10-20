import type { TranslationKey } from "../i18n/messages"

const fieldKeys: Record<string, TranslationKey> = {
  validUntil: "agreements.validation.validUntil",
  contactId: "validation.customer.required",
  quantity: "validation.line.qty.invalid",
  unitPrice: "validation.line.price.invalid",
}

/**
 * The editor's draft check, as one message per field a person can act on, rather than raw schema
 * paths such as "validUntil: Invalid date". Lines are keyed by their path, e.g. "deliverables.0.title".
 */
export function agreementDraftFieldErrors(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>) {
  const errors: Record<string, TranslationKey> = {}
  for (const issue of issues) {
    const field = issue.path.map(String).join(".")
    errors[field] ??= fieldKeys[String(issue.path.at(-1))] ?? "validation.required"
  }
  return errors
}
