// MOCK: synthetic test organizations, parties, document amounts and rates only.
import { afterEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { invoicePolicyIssues, requireInvoiceIssuancePolicy } from "../issuance-policy"
import { setRuntimeExtensions } from "../../../lib/runtime/extensions"
import type { InvoiceIssuancePolicy } from "../../../lib/runtime/invoice-issuance-policy"

const policy: InvoiceIssuancePolicy = { sellerCountry: "DK", buyerCountries: ["DK"], currencies: ["DKK", "EUR"], standardVatRate: "25", requireCvr: true, requireBusinessBuyer: true, requireIdentity: true, requireSupplyDate: true, sellerVatRegistered: true }
const document = {
  currency: "DKK", countryCode: "DK", purpose: "sale", supplyDate: "2026-10-09",
  sellerSnapshot: { momsRegistered: true, countryCode: "DK", companyName: "Synthetic Seller ApS", companyAddress: "Testvej 1, 1000 København", taxIds: [{ scheme: "cvr", value: "12345678", countryCode: "DK" }] },
  buyerSnapshot: { name: "Synthetic Buyer", company: "Synthetic Buyer ApS", address: "Testvej 2", city: "København", zip: "1000", country: "DK" },
  items: [{ vatTreatment: "standard", vatCountry: "DK", taxRate: "25", vatRateInput: "0.25" }],
}
afterEach(() => setRuntimeExtensions([]))

describe("optional invoice issuance policy", () => {
  it.each(["DKK", "EUR"])("accepts a registered Danish domestic 25%% sale in %s", currency => {
    expect(invoicePolicyIssues({ ...document, currency }, policy)).toEqual([])
  })
  it.each([
    ["seller name", { sellerSnapshot: { ...document.sellerSnapshot, companyName: " " } }],
    ["seller address", { sellerSnapshot: { ...document.sellerSnapshot, companyAddress: "" } }],
    ["seller country", { sellerSnapshot: { ...document.sellerSnapshot, countryCode: "SE" } }],
    ["seller CVR", { sellerSnapshot: { ...document.sellerSnapshot, taxIds: [] } }],
    ["bad CVR", { sellerSnapshot: { ...document.sellerSnapshot, taxIds: [{ scheme: "cvr", value: "123", countryCode: "DK" }] } }],
    ["buyer name", { buyerSnapshot: { ...document.buyerSnapshot, name: "" } }],
    ["buyer address", { buyerSnapshot: { ...document.buyerSnapshot, address: "" } }],
    ["buyer city", { buyerSnapshot: { ...document.buyerSnapshot, city: "" } }],
    ["buyer postal code", { buyerSnapshot: { ...document.buyerSnapshot, zip: "" } }],
    ["foreign buyer", { buyerSnapshot: { ...document.buyerSnapshot, country: "SE" } }],
    ["private buyer", { buyerSnapshot: { ...document.buyerSnapshot, company: "" } }],
    ["supply date", { supplyDate: null }],
    ["currency", { currency: "USD" }],
    ["purpose", { purpose: "prepayment" }],
    ["exempt", { items: [{ ...document.items[0]!, vatTreatment: "exempt" }] }],
    ["reverse charge", { items: [{ ...document.items[0]!, vatTreatment: "reverse_charge" }] }],
    ["foreign VAT", { items: [{ ...document.items[0]!, vatCountry: "SE" }] }],
    ["wrong rate", { items: [{ ...document.items[0]!, taxRate: "20" }] }],
    ["inconsistent input rate", { items: [{ ...document.items[0]!, vatRateInput: "0.20" }] }],
    ["mixed invoice", { items: [...document.items, { ...document.items[0]!, vatTreatment: "exempt", taxRate: "0", vatRateInput: "0" }] }],
  ])("rejects missing or unsupported %s", (_field, patch) => {
    expect(invoicePolicyIssues({ ...document, ...patch }, policy).length).toBeGreaterThan(0)
  })
  it("returns separate actionable field issues without English prose", () => {
    expect(invoicePolicyIssues({ ...document, buyerSnapshot: { ...document.buyerSnapshot, company: "", country: "SE" } }, policy)).toEqual([
      { code: "customer.country.unsupported", field: "customer.country", params: { countries: "DK" } },
      { code: "customer.businessName.required", field: "customer.company", params: {} },
    ])
  })
  it("requires a buyer CVR or SE number only when the policy asks for one", () => {
    const issue = { code: "customer.cvr.required", field: "customer.taxId", params: {} }
    expect(invoicePolicyIssues(document, policy)).toEqual([])
    expect(invoicePolicyIssues(document, { ...policy, requireBuyerCvr: true })).toEqual([issue])
    for (const taxIds of [[{ scheme: "cvr", value: "12345674", countryCode: "DK" }], [{ scheme: "se", value: "87654321", countryCode: "DK" }]])
      expect(invoicePolicyIssues({ ...document, buyerSnapshot: { ...document.buyerSnapshot, taxIds } }, { ...policy, requireBuyerCvr: true })).toEqual([])
    expect(invoicePolicyIssues({ ...document, buyerSnapshot: { ...document.buyerSnapshot, taxIds: [{ scheme: "cvr", value: "123", countryCode: "DK" }] } }, { ...policy, requireBuyerCvr: true })).toEqual([issue])
  })
  it.each(["Danmark", "Denmark", "dk"])("accepts the recognised historical country %s", country => {
    expect(invoicePolicyIssues({ ...document, buyerSnapshot: { ...document.buyerSnapshot, country } }, policy)).toEqual([])
  })
  it.each([undefined, null])("does not infer VAT registration from a CVR: %s", momsRegistered => {
    expect(invoicePolicyIssues({ ...document, sellerSnapshot: { ...document.sellerSnapshot, momsRegistered } }, policy).length).toBeGreaterThan(0)
  })
  it("accepts explicit non-registration and zero VAT, while retaining the other restrictions", () => {
    const zero = { ...document, sellerSnapshot: { ...document.sellerSnapshot, momsRegistered: false }, items: [{ ...document.items[0]!, vatTreatment: "unclassified_zero", taxRate: "0", vatRateInput: "0" }] }
    expect(invoicePolicyIssues(zero, { ...policy, sellerVatRegistered: false })).toEqual([])
    expect(invoicePolicyIssues({ ...zero, items: document.items }, policy).length).toBeGreaterThan(0)
    expect(invoicePolicyIssues({ ...zero, currency: "USD" }, policy).length).toBeGreaterThan(0)
    expect(invoicePolicyIssues({ ...zero, buyerSnapshot: { ...document.buyerSnapshot, country: "SE" } }, policy).length).toBeGreaterThan(0)
  })
  it.each([true, false, null])("refuses missing identity-bound evidence even when the snapshot registration is %s", momsRegistered => {
    expect(invoicePolicyIssues({ ...document, sellerSnapshot: { ...document.sellerSnapshot, momsRegistered } }, { sellerVatStatus: "unset" }).length).toBeGreaterThan(0)
  })
  it.each([["registered", true], ["not_registered", false]] as const)("matches identity-bound %s evidence only to snapshot %s", (sellerVatStatus, registered) => {
    expect(invoicePolicyIssues({ ...document, sellerSnapshot: { ...document.sellerSnapshot, momsRegistered: registered } }, { sellerVatStatus })).toEqual([])
    expect(invoicePolicyIssues({ ...document, sellerSnapshot: { ...document.sellerSnapshot, momsRegistered: !registered } }, { sellerVatStatus }).length).toBeGreaterThan(0)
  })
  it.each([true, false])("enforces explicit adopter confirmation %s in both directions without rate restrictions", confirmation => {
    for (const status of [true, false, null, undefined]) {
      const issues = invoicePolicyIssues({ ...document, sellerSnapshot: { ...document.sellerSnapshot, momsRegistered: status } }, { sellerVatRegistered: confirmation })
      expect(issues.length).toBe(status === confirmation ? 0 : 1)
    }
  })
  it("refuses a zero VAT seller when the adopter affirms registration", () => {
    const zero = { ...document, sellerSnapshot: { ...document.sellerSnapshot, momsRegistered: false }, items: [{ ...document.items[0]!, vatTreatment: "unclassified_zero", taxRate: "0", vatRateInput: "0" }] }
    expect(invoicePolicyIssues(zero, policy)).toEqual([{ code: "seller.vatRegistration.required", field: "seller.vatRegistered", params: {} }])
  })
  it("preserves self-host scope when no policy is installed", async () => {
    await expect(Effect.runPromise(requireInvoiceIssuancePolicy("test", { ...document, currency: "USD", sellerSnapshot: {}, buyerSnapshot: null }))).resolves.toBeUndefined()
  })
  it("lets a self-hosted organization issue without bank details or Stripe", async () => {
    setRuntimeExtensions([])
    await expect(Effect.runPromise(requireInvoiceIssuancePolicy("test", { ...document, paymentAvailable: false }))).resolves.toBeUndefined()
  })
  it("passes the effective identity to the adopter and enforces its policy", async () => {
    setRuntimeExtensions([{ id: "synthetic", resolveInvoiceIssuancePolicy: context => {
      expect(context.seller).toEqual(document.sellerSnapshot)
      expect(context.organizationId).toBe("test")
      return policy
    } }])
    await expect(Effect.runPromise(requireInvoiceIssuancePolicy("test", document))).resolves.toBeUndefined()
    const refused = await Effect.runPromise(Effect.either(requireInvoiceIssuancePolicy("test", { ...document, currency: "USD" })))
    expect(refused).toMatchObject({ _tag: "Left", left: { code: "invoice_issuance_policy", fieldIssues: [
      { code: "currency.unsupported", field: "currency", params: { currencies: "DKK, EUR" } },
    ] } })
  })
  it("keeps the readable policy sentence next to the field issues, since API clients and agents read the message", async () => {
    setRuntimeExtensions([{ id: "synthetic", resolveInvoiceIssuancePolicy: () => policy }])
    const mixed = { ...document, items: [document.items[0]!, { ...document.items[0]!, taxRate: "0", vatRateInput: "0", vatTreatment: "exempt" }] }
    const refused = await Effect.runPromise(Effect.either(requireInvoiceIssuancePolicy("test", mixed)))
    expect(refused).toMatchObject({ _tag: "Left", left: {
      code: "invoice_issuance_policy",
      message: "Only ordinary domestic sales with 25% VAT are supported. Exempt, mixed, foreign and special VAT cases need a supported invoicing service.",
      fieldIssues: [{ code: "vat.unsupported", field: "items.1.vat", params: { rate: "25" } }],
    } })
  })
  it("holds back an unpaid-for invoice only when the adopter requires payment details", async () => {
    const unpaid = { ...document, paymentAvailable: false }
    expect(invoicePolicyIssues(unpaid, policy)).toEqual([])
    expect(invoicePolicyIssues(unpaid, { ...policy, requirePaymentDetails: true })).toEqual([
      { code: "seller.bank.required", field: "seller.bankAccount", params: {} },
    ])
    expect(invoicePolicyIssues({ ...document, paymentAvailable: true }, { ...policy, requirePaymentDetails: true })).toEqual([])
    // No adopter policy at all: a self-hosted organization paid by other means still sends.
    await expect(Effect.runPromise(requireInvoiceIssuancePolicy("test", unpaid))).resolves.toBeUndefined()
  })
})
