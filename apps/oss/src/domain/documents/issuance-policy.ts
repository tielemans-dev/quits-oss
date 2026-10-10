import { Effect } from "effect"
import { parseBuyerSnapshot, parseSellerSnapshot } from "@quits/contracts/documents"
import type { InvoiceIssuancePolicy } from "../../lib/runtime/invoice-issuance-policy"
import { getRuntimeExtensions } from "../../lib/runtime/extensions"
import { InvalidState } from "../errors"
import { toDecimal } from "../../lib/exports/format"
import { sellerCvr } from "../../lib/documents/invoice-identity"

type InvoicePolicyInput = {
  currency: string
  countryCode: string
  purpose: string
  supplyDate: Date | string | null
  sellerSnapshot: unknown
  buyerSnapshot: unknown
  items: Array<{ vatTreatment: string; vatCountry: string | null; taxRate: { toString(): string }; vatRateInput: string | null }>
}

export function invoicePolicyIssues(document: InvoicePolicyInput, policy: InvoiceIssuancePolicy): string[] {
  const seller = parseSellerSnapshot(document.sellerSnapshot)
  const buyer = parseBuyerSnapshot(document.buyerSnapshot)
  const issues: string[] = []
  if (policy.requireIdentity) {
    if (!seller?.companyName?.trim() || !seller.companyAddress?.trim()) issues.push("Set the seller's name and postal address before issuing.")
    if (!buyer?.name?.trim() || !buyer.address?.trim() || !buyer.city?.trim() || !buyer.zip?.trim() || !buyer.country?.trim()) issues.push("Set the customer's name and complete postal address before issuing.")
  }
  if (policy.sellerCountry && seller?.countryCode !== policy.sellerCountry) issues.push(`Only sellers in ${policy.sellerCountry} are supported by this issuance policy.`)
  if (policy.requireCvr && !sellerCvr(seller?.taxIds)) issues.push("Set a valid Danish CVR in the seller identity before issuing.")
  if (policy.sellerVatRegistered !== undefined && !policy.sellerVatRegistered) issues.push("Confirm VAT registration for this seller before issuing. A CVR alone does not establish VAT registration.")
  // A restricted standard-VAT policy must have affirmative registration evidence.
  if (policy.standardVatRate && policy.sellerVatRegistered !== true) issues.push("VAT registration confirmation is missing for this seller. Complete the registration settings before issuing.")
  if (policy.buyerCountries && !policy.buyerCountries.includes(buyer?.country ?? "")) issues.push(`Only customers in ${policy.buyerCountries.join(", ")} are supported. Correct the customer country or use a supported invoicing service.`)
  if (policy.requireBusinessBuyer && !buyer?.company?.trim()) issues.push("This issuance policy supports business customers only. Set the customer's business name.")
  if (policy.currencies && !policy.currencies.includes(document.currency)) issues.push(`Use a supported invoice currency: ${policy.currencies.join(", ")}.`)
  if (policy.requireSupplyDate && !document.supplyDate) issues.push("Confirm the supply date before issuing.")
  if (policy.standardVatRate) {
    if ((policy.sellerCountry && document.countryCode !== policy.sellerCountry) || document.purpose !== "sale" || !document.items.length || document.items.some(line =>
      line.vatTreatment !== "standard" || (line.vatCountry !== null && policy.sellerCountry !== undefined && line.vatCountry !== policy.sellerCountry) ||
      !toDecimal(line.taxRate.toString()).eq(policy.standardVatRate!) ||
      (line.vatRateInput !== null && !toDecimal(line.vatRateInput).times(100).eq(policy.standardVatRate!)))) {
      issues.push(`Only ordinary domestic sales with ${policy.standardVatRate}% VAT are supported. Exempt, mixed, foreign and special VAT cases need a supported invoicing service.`)
    }
  }
  return issues
}

/** Evaluated on the effective frozen identity, both before preparation and under issuance locks. */
export const requireInvoiceIssuancePolicy = (organizationId: string, document: InvoicePolicyInput) => Effect.gen(function* () {
  const seller = parseSellerSnapshot(document.sellerSnapshot) ?? {}
  const buyer = parseBuyerSnapshot(document.buyerSnapshot)
  for (const extension of getRuntimeExtensions()) {
    if (!extension.resolveInvoiceIssuancePolicy) continue
    const policy = yield* Effect.tryPromise({
      try: async () => extension.resolveInvoiceIssuancePolicy!({ organizationId, seller, buyer }),
      catch: () => new InvalidState({ code: "issuance_policy_unavailable", message: "Invoice issuance policy is unavailable. Try again or contact the operator." }),
    })
    if (!policy) continue
    const issues = invoicePolicyIssues(document, policy)
    if (issues.length) return yield* new InvalidState({ code: "invoice_issuance_policy", message: issues.join(" ") })
  }
})
