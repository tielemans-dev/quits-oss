// MOCK: synthetic test parties, CVRs and amounts only.
import { describe, expect, it } from "vitest"
import type { FrozenVatGroup } from "@quits/contracts/pricing"
import { vatGroupKey } from "@quits/shared/pricing"
import { buildUblDocument, isEinvoiceVatClassified, validateEinvoice } from "../../../lib/exports/ubl"
import { frozenEinvoiceInput } from "../einvoice-input"

const zero: FrozenVatGroup = { key: vatGroupKey({ treatment: "unclassified_zero", country: null, reasonCode: null, rate: "0" }), treatment: "unclassified_zero", reasonCode: null, country: null, rate: "0",
  exponent: 2, baseExponent: 2, net: "8500.00", tax: "0.00", gross: "8500.00", payableRounding: "0.00",
  netBase: "8500.00", taxBase: "0.00", grossBase: "8500.00", payableRoundingBase: "0.00" }

/** What issuance freezes for a Danish sole trader who is not VAT-registered, billing a Danish company. */
function issued(momsRegistered: boolean | null) {
  return frozenEinvoiceInput({
    kind: "invoice", taxRegime: "eu_vat", countryCode: "DK", locale: "da-DK", dueDate: "2026-11-04", orderReference: null, billingReference: null, note: null,
    money: {
      number: "2026-0005", issueDate: "2026-10-21", supplyDate: "2026-10-21", currency: "DKK",
      seller: { companyName: "Synthetic Enkeltmand", companyAddress: "Testvej 1\n9000 Aalborg", countryCode: "DK", momsRegistered, taxIds: [{ scheme: "cvr", value: "12345674", countryCode: "DK" }] },
      buyer: { name: "Synthetic Buyer", company: "Synthetic Buyer ApS", address: "Testvej 2", city: "Aalborg", zip: "9000", country: "DK", taxIds: [{ scheme: "cvr", value: "87654328", countryCode: "DK" }] },
      calculation: { version: "v2", roundingMode: "half_up", pricesIncludeTax: false, exponent: 2, baseExponent: 2 },
      vatGroups: [zero], totals: { net: "8500.00", tax: "0.00", gross: "8500.00", payableRounding: "0.00", netBase: "8500.00", taxBase: "0.00", grossBase: "8500.00", payableRoundingBase: "0.00" },
    } as never,
    contact: { name: "Synthetic Buyer", email: null, company: "Synthetic Buyer ApS", address: "Testvej 2", city: "Aalborg", state: null, zip: "9000", country: "DK", taxId: null, taxIds: [], peppolEndpointId: null, peppolEndpointScheme: null } as never,
    lines: [{ description: "Design", quantity: "10", unitPriceNet: "850", lineNet: "8500", taxRate: "0", taxCategory: "unclassified_zero", vatTreatment: "unclassified_zero", vatCountry: null, vatReasonCode: null, vatRateInput: "0" }],
  })
}

describe("frozen e-invoice input", () => {
  it("is a valid e-invoice for a seller who is not VAT-registered, so issuance stores its UBL", () => {
    const document = issued(false)
    expect(isEinvoiceVatClassified(document)).toBe(true)
    expect(validateEinvoice(document)).toEqual([])
    const xml = buildUblDocument(document)
    expect(xml).toContain("<cbc:ID>O</cbc:ID>")
    expect(xml).toContain("Not subject to VAT")
    expect(xml).not.toContain("cbc:Percent")
    // BR-O-02: neither party carries a VAT identifier; both keep their CVR as legal ID and endpoint.
    expect(xml).not.toContain("cac:PartyTaxScheme")
    expect(xml).toContain('<cbc:EndpointID schemeID="0184">87654328</cbc:EndpointID>')
  })
  it.each([true, null])("still has no UBL category for unclassified zero when registration is %s", momsRegistered => {
    expect(isEinvoiceVatClassified(issued(momsRegistered))).toBe(false)
  })
})
