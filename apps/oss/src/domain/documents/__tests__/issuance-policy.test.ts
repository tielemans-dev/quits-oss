import { afterEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { invoicePolicyIssues, requireInvoiceIssuancePolicy } from "../issuance-policy"
import { setRuntimeExtensions } from "../../../lib/runtime/extensions"
import type { InvoiceIssuancePolicy } from "../../../lib/runtime/invoice-issuance-policy"

const policy: InvoiceIssuancePolicy = { sellerCountry: "DK", buyerCountries: ["DK"], currencies: ["DKK", "EUR"], standardVatRate: "25", requireCvr: true, requireBusinessBuyer: true, requireIdentity: true, requireSupplyDate: true, sellerVatRegistered: true }
const document = {
  currency: "DKK", countryCode: "DK", purpose: "sale", supplyDate: "2026-10-09",
  sellerSnapshot: { countryCode: "DK", companyName: "Synthetic Seller ApS", companyAddress: "Testvej 1, 1000 København", taxIds: [{ scheme: "cvr", value: "12345678", countryCode: "DK" }] },
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
  it.each([undefined, false])("does not infer VAT registration from a CVR: %s", sellerVatRegistered => {
    expect(invoicePolicyIssues(document, { ...policy, sellerVatRegistered }).join(" ")).toContain("VAT registration")
  })
  it("preserves self-host scope when no policy is installed", async () => {
    await expect(Effect.runPromise(requireInvoiceIssuancePolicy("test", { ...document, currency: "USD", sellerSnapshot: {}, buyerSnapshot: null }))).resolves.toBeUndefined()
  })
  it("passes the effective identity to the adopter and enforces its policy", async () => {
    setRuntimeExtensions([{ id: "synthetic", resolveInvoiceIssuancePolicy: context => {
      expect(context.seller).toEqual(document.sellerSnapshot)
      expect(context.organizationId).toBe("test")
      return policy
    } }])
    await expect(Effect.runPromise(requireInvoiceIssuancePolicy("test", document))).resolves.toBeUndefined()
    await expect(Effect.runPromise(requireInvoiceIssuancePolicy("test", { ...document, currency: "USD" }))).rejects.toThrow("supported invoice currency")
  })
})
