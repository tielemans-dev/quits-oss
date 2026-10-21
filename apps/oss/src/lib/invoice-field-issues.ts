import type { FieldIssue } from "@quits/contracts/agent"
import type { TranslationKey } from "./i18n/messages"

const issueKeys: Record<string, TranslationKey> = {
  changed_since_review: "invoiceValidation.changedSinceReview",
  missing_recipient: "invoices.detail.email.fallback.invalidRecipient.title",
  required: "invoiceValidation.required",
  quantityInvalid: "docForm.validation.quantityInvalid",
  descriptionTooLong: "invoiceValidation.description.tooLong",
  unitPriceInvalid: "invoiceValidation.unitPrice.invalid",
  "customer.required": "invoiceValidation.customer.required",
  "cvr.invalid": "invoiceValidation.cvr.invalid",
  "prefix.conflict": "settings.validation.prefixConflict",
  "customer.businessName.required": "invoiceValidation.customer.businessName.required",
  "customer.cvr.required": "invoiceValidation.customer.cvr.required",
  "customer.country.unsupported": "invoiceValidation.customer.country.unsupported",
  "seller.country.unsupported": "invoiceValidation.seller.country.unsupported",
  "seller.vatRegistration.required": "invoiceValidation.seller.vatRegistration.required",
  "seller.bank.required": "invoiceValidation.seller.bank.required",
  "currency.unsupported": "invoiceValidation.currency.unsupported",
  "vat.unsupported": "invoiceValidation.vat.unsupported",
}
export function invoiceIssueKey(code: string): TranslationKey { return issueKeys[code] ?? "invoiceValidation.unknown" }
export function invoiceFieldIssues(error: unknown): FieldIssue[] {
  const data = (error as { data?: { fieldIssues?: unknown } } | null)?.data?.fieldIssues
  if (!Array.isArray(data)) return []
  return data.filter((issue): issue is FieldIssue => issue && typeof issue.code === "string" && typeof issue.field === "string" && issue.params && typeof issue.params === "object")
}
