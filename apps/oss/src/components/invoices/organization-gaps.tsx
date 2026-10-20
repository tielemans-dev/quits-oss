import type { FieldIssue } from "@quits/contracts/agent"
import { Link } from "@tanstack/react-router"
import { useI18n } from "../../lib/i18n/react"
import type { TranslationKey } from "../../lib/i18n/messages"
import { invoiceIssueKey } from "../../lib/invoice-field-issues"

const sellerFieldKeys: Record<string, TranslationKey> = {
  "seller.companyName": "invoiceValidation.seller.companyName.required",
  "seller.companyAddress": "invoiceValidation.seller.companyAddress.required",
}

/**
 * A single recovery action, also when identity and payment details are both missing.
 * `issues` block sending; `warnings` only suggest a fix, so the bank gap is a nudge unless an adopter policy requires it.
 */
export function OrganizationGaps({ issues, warnings = [] }: { issues: readonly FieldIssue[]; warnings?: readonly FieldIssue[] }) {
  const { t } = useI18n()
  const bankBlocking = issues.some(issue => issue.code === "seller.bank.required")
  const bank = bankBlocking || warnings.some(issue => issue.code === "seller.bank.required")
  const sellerIssues = issues.filter(issue => issue.field.startsWith("seller.") && issue.code !== "seller.bank.required")
  const missingCvr = sellerIssues.some(issue => issue.code === "cvr.invalid")
  const missingVatChoice = sellerIssues.some(issue => issue.code === "seller.vatRegistration.required")
  // Only the CVR and VAT-registration gaps get that wording; any other seller blocker says what it is.
  const other = sellerIssues.filter(issue => issue.code !== "cvr.invalid" && issue.code !== "seller.vatRegistration.required")
  const seller = sellerIssues.length > 0
  if (!bank && !seller) return null
  const card = seller ? "sellerCard" : "bankCard"
  const blocking = seller || bankBlocking
  return <section role={blocking ? "alert" : "status"} data-testid="organization-gaps" className="grid gap-3 rounded-md border p-4">
    <h2 className="font-semibold">{t(`invoiceValidation.${card}.title`)}</h2>
    {missingCvr && missingVatChoice && <p className="text-sm">{t("invoiceValidation.sellerCard.body")}</p>}
    {missingCvr !== missingVatChoice && <p className="text-sm">{t(missingCvr ? "invoiceValidation.cvr.invalid" : "invoiceValidation.seller.vatRegistration.required")}</p>}
    {other.map(issue => <p key={`${issue.code}:${issue.field}`} className="text-sm">{t(sellerFieldKeys[issue.field] ?? invoiceIssueKey(issue.code), issue.params)}</p>)}
    {bank && <p className="text-sm">{t(bankBlocking ? "invoiceValidation.bankCard.body" : "invoiceValidation.bankCard.optionalBody")}</p>}
    {/* Seller identity and the VAT answer live under Company; bank details under Payments. */}
    <Link to="/settings/$section" params={{ section: seller ? "company" : "payments" }} className="w-fit text-sm underline underline-offset-4">{t(`invoiceValidation.${card}.action`)}</Link>
  </section>
}
