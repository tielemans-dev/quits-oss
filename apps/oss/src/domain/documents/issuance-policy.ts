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
  paymentAvailable?: boolean
  items: Array<{ vatTreatment: string; vatCountry: string | null; taxRate: { toString(): string }; vatRateInput: string | null }>
}

/** Each finding carries the field-addressed issue the UI maps and the sentence an API client or agent reads. */
type PolicyFinding = { issue: FieldIssue; message: string }

function policyFindings(document: InvoicePolicyInput, policy: InvoiceIssuancePolicy): PolicyFinding[] {
  const seller = parseSellerSnapshot(document.sellerSnapshot)
  const buyer = parseBuyerSnapshot(document.buyerSnapshot)
  const findings: PolicyFinding[] = []
  const add = (code: string, field: string, message: string, params: FieldIssue["params"] = {}) => findings.push({ issue: { code, field, params }, message })
  const sellerIdentity = "Set the seller's name and postal address before issuing."
  const customerIdentity = "Set the customer's name and complete postal address before issuing."
  const vatConfirmation = "Seller VAT registration confirmation is missing or does not match the effective seller."
  if (policy.requireIdentity) {
    for (const field of ["companyName", "companyAddress"] as const) if (!seller?.[field]?.trim()) add("required", `seller.${field}`, sellerIdentity)
    for (const field of ["name", "address", "city", "zip", "country"] as const) if (!buyer?.[field]?.trim()) add("required", `customer.${field}`, customerIdentity)
  }
  if (policy.sellerCountry && seller?.countryCode !== policy.sellerCountry)
    add("seller.country.unsupported", "seller.countryCode", `Only sellers in ${policy.sellerCountry} are supported by this issuance policy.`, { country: policy.sellerCountry })
  if (policy.requireCvr && !sellerCvr(seller?.taxIds)) add("cvr.invalid", "seller.cvr", "Set a valid Danish CVR in the seller identity before issuing.")
  if ((policy.requireSellerVatStatus || policy.standardVatRate) && seller?.momsRegistered == null)
    add("seller.vatRegistration.required", "seller.vatRegistered", "Choose whether this seller is VAT-registered before issuing.")
  if (policy.sellerVatStatus === "unset" || (policy.sellerVatStatus !== undefined && seller?.momsRegistered !== (policy.sellerVatStatus === "registered")))
    add("seller.vatRegistration.required", "seller.vatRegistered", vatConfirmation)
  if (policy.sellerVatRegistered !== undefined && seller?.momsRegistered !== policy.sellerVatRegistered)
    add("seller.vatRegistration.required", "seller.vatRegistered", vatConfirmation)
  if (policy.buyerCountries && !policy.buyerCountries.includes(toCountryCode(buyer?.country) ?? ""))
    add("customer.country.unsupported", "customer.country", `Only customers in ${policy.buyerCountries.join(", ")} are supported. Correct the customer country or use a supported invoicing service.`, { countries: policy.buyerCountries.join(", ") })
  if (policy.requireBusinessBuyer && !buyer?.company?.trim()) add("customer.businessName.required", "customer.company", "This issuance policy supports business customers only. Set the customer's business name.")
  if (policy.requireBuyerCvr && !sellerCvr(buyer?.taxIds) && !buyer?.taxIds?.some(id => id.scheme?.trim().toLowerCase() === "se" && /^\d{8}$/.test(id.value.replace(/\s/g, ""))))
    add("customer.cvr.required", "customer.taxId", "Set the customer's CVR or SE number before issuing.")
  if (policy.currencies && !policy.currencies.includes(document.currency)) add("currency.unsupported", "currency", `Use a supported invoice currency: ${policy.currencies.join(", ")}.`, { currencies: policy.currencies.join(", ") })
  if (policy.requireSupplyDate && !document.supplyDate) add("required", "supplyDate", "Confirm the supply date before issuing.")
  if (policy.requirePaymentDetails && document.paymentAvailable === false) add("seller.bank.required", "seller.bankAccount", "Add a bank account or a payment link before issuing.")
  if (policy.standardVatRate) {
    const nonRegistered = seller?.momsRegistered === false
    const rate = nonRegistered ? "0" : policy.standardVatRate
    const unsupported = nonRegistered
      ? "A non-VAT-registered seller must issue ordinary domestic sales without VAT."
      : `Only ordinary domestic sales with ${rate}% VAT are supported. Exempt, mixed, foreign and special VAT cases need a supported invoicing service.`
    if ((policy.sellerCountry && document.countryCode !== policy.sellerCountry) || document.purpose !== "sale" || !document.items.length) add("vat.unsupported", "items", unsupported, { rate })
    document.items.forEach((line, index) => {
      const treatmentAllowed = nonRegistered ? ["unclassified_zero", "out_of_scope"].includes(line.vatTreatment) : line.vatTreatment === "standard"
      if (!treatmentAllowed || (line.vatCountry !== null && policy.sellerCountry !== undefined && line.vatCountry !== policy.sellerCountry) ||
        !toDecimal(line.taxRate.toString()).eq(rate) ||
        (line.vatRateInput !== null && !toDecimal(line.vatRateInput).times(100).eq(rate))) add("vat.unsupported", `items.${index}.vat`, unsupported, { rate })
    })
  }
  return findings
}

export const invoicePolicyIssues = (document: InvoicePolicyInput, policy: InvoiceIssuancePolicy): FieldIssue[] =>
  policyFindings(document, policy).map(finding => finding.issue)

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
  const findings = policies.flatMap(policy => policyFindings(document, policy))
  if (findings.length) return yield* new InvalidState({
    code: "invoice_issuance_policy",
    message: [...new Set(findings.map(finding => finding.message))].join(" "),
    fieldIssues: findings.map(finding => finding.issue),
  })
})

/** Resends never reprice or re-check identity, but an adopter that requires payment details still holds them back. */
export const requireResendPaymentDetails = (organizationId: string, document: Pick<InvoicePolicyInput, "sellerSnapshot" | "buyerSnapshot">, paymentAvailable: boolean) => Effect.gen(function* () {
  if (paymentAvailable) return
  const policies = yield* Effect.tryPromise({
    try: () => resolveInvoicePolicies(organizationId, document),
    catch: () => new InvalidState({ code: "issuance_policy_unavailable", message: "Invoice issuance policy is unavailable" }),
  })
  if (policies.some(policy => policy.requirePaymentDetails))
    return yield* new InvalidState({ code: "invoice_issuance_policy", message: "Complete the invoice details before sending",
      fieldIssues: [{ code: "seller.bank.required", field: "seller.bankAccount", params: {} }] })
})
