import type { FieldIssue } from "@quits/contracts/agent"
import { Link } from "@tanstack/react-router"
import { useI18n } from "../../lib/i18n/react"

/**
 * A single recovery action, also when identity and payment details are both missing.
 * `issues` block sending; `warnings` only suggest a fix, so the bank gap is a nudge unless an adopter policy requires it.
 */
export function OrganizationGaps({ issues, warnings = [] }: { issues: readonly FieldIssue[]; warnings?: readonly FieldIssue[] }) {
  const { t } = useI18n()
  const bankBlocking = issues.some(issue => issue.code === "seller.bank.required")
  const bank = bankBlocking || warnings.some(issue => issue.code === "seller.bank.required")
  const seller = issues.some(issue => issue.field.startsWith("seller.") && issue.code !== "seller.bank.required")
  if (!bank && !seller) return null
  const card = seller ? "sellerCard" : "bankCard"
  const blocking = seller || bankBlocking
  return <section role={blocking ? "alert" : "status"} data-testid="organization-gaps" className="grid gap-3 rounded-md border p-4">
    <h2 className="font-semibold">{t(`invoiceValidation.${card}.title`)}</h2>
    {seller && <p className="text-sm">{t("invoiceValidation.sellerCard.body")}</p>}
    {bank && <p className="text-sm">{t(bankBlocking ? "invoiceValidation.bankCard.body" : "invoiceValidation.bankCard.optionalBody")}</p>}
    <Link to="/settings" className="w-fit text-sm underline underline-offset-4">{t(`invoiceValidation.${card}.action`)}</Link>
  </section>
}
