import { Effect } from "effect"
import type { FieldIssue } from "@quits/contracts/agent"
import { toCountryCode } from "../../lib/exports/parties"
import { parseBuyerSnapshot, parseSellerSnapshot } from "@quits/contracts/documents"
import type { InvoiceIssuancePolicy } from "../../lib/runtime/invoice-issuance-policy"
import { getRuntimeExtensions } from "../../lib/runtime/extensions"
import { InvalidState } from "../errors"
import { toDecimal } from "../../lib/exports/format"
import { sellerCvr } from "../../lib/documents/invoice-identity"

export type InvoicePolicyInput = {
  currency: string
  countryCode: string
  purpose: string
  supplyDate: Date | string | null
  sellerSnapshot: unknown
  buyerSnapshot: unknown
  items: Array<{ vatTreatment: string; vatCountry: string | null; taxRate: { toString(): string }; vatRateInput: string | null }>
}

export function invoicePolicyIssues(document: InvoicePolicyInput, policy: InvoiceIssuancePolicy): FieldIssue[] {
  const seller = parseSellerSnapshot(document.sellerSnapshot)
  const buyer = parseBuyerSnapshot(document.buyerSnapshot)
  const issues: FieldIssue[] = []
  const add = (code: string, field: string, params: FieldIssue["params"] = {}) => issues.push({ code, field, params })
  if (policy.requireIdentity) {
    for (const field of ["companyName", "companyAddress"] as const) if (!seller?.[field]?.trim()) add("required", `seller.${field}`)
    for (const field of ["name", "address", "city", "zip", "country"] as const) if (!buyer?.[field]?.trim()) add("required", `customer.${field}`)
  }
  if (policy.sellerCountry && seller?.countryCode !== policy.sellerCountry) add("seller.country.unsupported", "seller.countryCode", { country: policy.sellerCountry })
  if (policy.requireCvr && !sellerCvr(seller?.taxIds)) add("cvr.invalid", "seller.cvr")
  if ((policy.requireSellerVatStatus || policy.standardVatRate) && seller?.momsRegistered == null)
    add("seller.vatRegistration.required", "seller.vatRegistered")
  if (policy.sellerVatStatus === "unset" || (policy.sellerVatStatus !== undefined && seller?.momsRegistered !== (policy.sellerVatStatus === "registered")))
    add("seller.vatRegistration.required", "seller.vatRegistered")
  if (policy.sellerVatRegistered !== undefined && seller?.momsRegistered !== policy.sellerVatRegistered)
    add("seller.vatRegistration.required", "seller.vatRegistered")
  if (policy.buyerCountries && !policy.buyerCountries.includes(toCountryCode(buyer?.country) ?? "")) add("customer.country.unsupported", "customer.country", { countries: policy.buyerCountries.join(", ") })
  if (policy.requireBusinessBuyer && !buyer?.company?.trim()) add("customer.businessName.required", "customer.company")
  if (policy.currencies && !policy.currencies.includes(document.currency)) add("currency.unsupported", "currency", { currencies: policy.currencies.join(", ") })
  if (policy.requireSupplyDate && !document.supplyDate) add("required", "supplyDate")
  if (policy.standardVatRate) {
    const nonRegistered = seller?.momsRegistered === false
    const rate = nonRegistered ? "0" : policy.standardVatRate
    if ((policy.sellerCountry && document.countryCode !== policy.sellerCountry) || document.purpose !== "sale" || !document.items.length) add("vat.unsupported", "items", { rate })
    document.items.forEach((line, index) => {
      const treatmentAllowed = nonRegistered ? ["unclassified_zero", "out_of_scope"].includes(line.vatTreatment) : line.vatTreatment === "standard"
      if (!treatmentAllowed || (line.vatCountry !== null && policy.sellerCountry !== undefined && line.vatCountry !== policy.sellerCountry) ||
        !toDecimal(line.taxRate.toString()).eq(rate) ||
        (line.vatRateInput !== null && !toDecimal(line.vatRateInput).times(100).eq(rate))) add("vat.unsupported", `items.${index}.vat`, { rate })
    })
  }
  return issues
}

/** The adopter decides restrictions. No hosted policy is embedded in the app. */
export async function resolveInvoicePolicies(organizationId: string, document: Pick<InvoicePolicyInput, "sellerSnapshot" | "buyerSnapshot">) {
  const seller = parseSellerSnapshot(document.sellerSnapshot) ?? {}
  const buyer = parseBuyerSnapshot(document.buyerSnapshot)
  const policies: InvoiceIssuancePolicy[] = []
  for (const extension of getRuntimeExtensions()) {
    if (!extension.resolveInvoiceIssuancePolicy) continue
    const policy = await extension.resolveInvoiceIssuancePolicy({ organizationId, seller, buyer })
    if (policy) policies.push(policy)
  }
  return policies
}

/** Evaluated on the effective frozen identity, both before preparation and under issuance locks. */
export const requireInvoiceIssuancePolicy = (organizationId: string, document: InvoicePolicyInput) => Effect.gen(function* () {
  const policies = yield* Effect.tryPromise({
    try: () => resolveInvoicePolicies(organizationId, document),
    catch: () => new InvalidState({ code: "issuance_policy_unavailable", message: "Invoice issuance policy is unavailable" }),
  })
  const issues = policies.flatMap(policy => invoicePolicyIssues(document, policy))
  if (issues.length) return yield* new InvalidState({ code: "invoice_issuance_policy", message: "Complete the invoice details before sending", fieldIssues: issues })
})
