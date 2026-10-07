import { describe, expect, it } from "vitest"
import { resolveCountryProfile } from "../../lib/compliance"
import { documentFractionDigits, priceDocument } from "../documents/pricing"

const profile = resolveCountryProfile("DK")

describe("document pricing", () => {
  it("rounds amounts to the currency's precision so no unpayable fraction is owed", () => {
    const priced = priceDocument({
      profile,
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
      profile,
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
