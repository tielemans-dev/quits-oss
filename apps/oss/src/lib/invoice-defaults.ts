import type { DocumentLineInput } from "@quits/contracts/invoices"
import { percentageToFraction } from "@quits/shared/pricing"

/** The VAT rate (a percentage) a new line starts at: zero for a seller who is not VAT-registered, else the policy or configured rate. */
export function defaultDocumentTaxRate(readiness: { momsRegistered?: boolean | null; standardVatRate?: string | null; taxRate: string }): string {
  return readiness.momsRegistered === false ? "0" : readiness.standardVatRate ?? readiness.taxRate
}

/**
 * Under a policy-fixed rate a line may only carry the mandatory treatment: standard VAT at that rate for a registered
 * seller, no VAT for one that is not. Any other explicit classification (a catalog item's, an AI draft's, one picked
 * before the policy was known) is dropped so the document rate applies. Returns the same array when nothing changes.
 */
export function reconcilePolicyVat<T extends { vat?: DocumentLineInput["vat"] }>(
  lines: T[],
  policy: { momsRegistered?: boolean | null; standardVatRate?: string | null },
): T[] {
  if (policy.standardVatRate == null) return lines
  const registered = policy.momsRegistered !== false
  const compliant = (vat: NonNullable<DocumentLineInput["vat"]>) => registered
    ? vat.treatment === "standard" && Number(vat.rate) === Number(percentageToFraction(policy.standardVatRate!))
    : (vat.treatment === "unclassified_zero" || vat.treatment === "out_of_scope") && Number(vat.rate) === 0
  if (lines.every(line => !line.vat || compliant(line.vat))) return lines
  return lines.map(line => line.vat && !compliant(line.vat) ? { ...line, vat: undefined } : line)
}
