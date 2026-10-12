import { describe, expect, it } from "vitest"
import { documentFractionDigits, priceDocument, priceDocumentV2 } from "../documents/pricing"

describe("document pricing", () => {
  it("rounds amounts to the currency's precision so no unpayable fraction is owed", () => {
    const priced = priceDocument({
      items: [{ description: "Consulting", quantity: 1, unitPrice: 105 }],
      taxRate: 25,
      pricesIncludeTax: false,
      currency: "JPY",
    })

    expect(priced.totalTax).toBe(26)
    expect(priced.totalGross).toBe(131)
    expect(priced.itemRows[0]).toMatchObject({ lineNet: 105, lineTax: 26, lineGross: 131 })
  })

  it("keeps two decimals for ordinary currencies", () => {
    const priced = priceDocument({
      items: [{ description: "Consulting", quantity: 1, unitPrice: 105 }],
      taxRate: 25,
      pricesIncludeTax: false,
      currency: "DKK",
    })
    expect(priced.totalGross).toBe(131.25)
  })

  it("caps three-decimal currencies at the two decimals documents store", () => {
    expect(documentFractionDigits("KWD")).toBe(2)
    expect(documentFractionDigits("JPY")).toBe(0)
    expect(documentFractionDigits("EUR")).toBe(2)
  })
})

// MOCK: synthetic domestic and cross-border seller/buyer pricing contexts.
describe("non-registered document defaults", () => {
  const input = { items: [{ description: "Service", quantity: 1, unitPrice: 100 }], taxRate: 0, pricesIncludeTax: false, currency: "DKK" }
  const vatDefaults = { momsRegistered: false, taxRegime: "eu_vat", countryCode: "DK", buyerCountry: "DK" }
  it("classifies ordinary domestic zero lines without changing their amounts", () => {
    const priced = priceDocumentV2({ ...input, vatDefaults })
    expect(priced.itemRows[0]).toMatchObject({ vatTreatment: "unclassified_zero", vatRateInput: "0", lineNet: "100.00", lineTax: "0.00", lineGross: "100.00" })
  })
  it.each([
    { momsRegistered: true }, { momsRegistered: null }, { taxRegime: "custom" },
    { taxRegime: "us_sales_tax" }, { buyerCountry: "DE" }, { countryCode: null }, { countryCode: "US", buyerCountry: "US" },
  ])("keeps ordinary zero classification for %j", change => {
    expect(priceDocumentV2({ ...input, vatDefaults: { ...vatDefaults, ...change } }).itemRows[0]?.vatTreatment).toBe("out_of_scope")
  })
  it("uses domestic defaults when the buyer country is omitted", () => {
    expect(priceDocumentV2({ ...input, vatDefaults: { ...vatDefaults, buyerCountry: null } }).itemRows[0]?.vatTreatment).toBe("unclassified_zero")
  })
  it("retains explicit classification and positive custom rates", () => {
    expect(priceDocumentV2({ ...input, vatDefaults, items: [{ ...input.items[0]!, vat: { treatment: "out_of_scope", rate: "0" } }] }).itemRows[0]?.vatTreatment).toBe("out_of_scope")
    expect(priceDocumentV2({ ...input, vatDefaults, taxRate: 25 }).itemRows[0]).toMatchObject({ vatTreatment: "standard", vatRateInput: "0.25", lineTax: "25.00" })
  })
})
