import { describe, expect, it } from "vitest"
import { resolveCountryProfile } from "../../../lib/compliance"
import { priceDocument } from "../../documents/pricing"
import { priceAgreement } from "../pricing"

describe("agreement pricing adapter", () => {
  it.each([
    { country: "DK", currency: "DKK", taxRate: 25, pricesIncludeTax: false },
    { country: "DK", currency: "DKK", taxRate: 25, pricesIncludeTax: true },
    { country: "US", currency: "USD", taxRate: 8.25, pricesIncludeTax: false },
    { country: "JP", currency: "JPY", taxRate: 10, pricesIncludeTax: false },
    { country: "US", currency: "KWD", taxRate: 0, pricesIncludeTax: false },
  ])("matches priceDocument fixtures for $currency, tax inclusive $pricesIncludeTax", (context) => {
    const lines = [
      { title: "Deposit", description: "Upfront", quantity: 1, unitPrice: 300.15, isDeposit: true },
      {
        title: "Balance",
        description: "Delivery",
        quantity: 2.25,
        unitPrice: 311.17,
        agreedDate: "2026-11-01",
      },
    ]
    const input = { ...context, profile: resolveCountryProfile(context.country) }
    const actual = priceAgreement({ ...input, deliverables: lines })
    const expected = priceDocument({ ...input, items: lines })
    expect({
      subtotalNet: actual.subtotalNet,
      totalTax: actual.totalTax,
      totalGross: actual.totalGross,
    }).toEqual({
      subtotalNet: expected.subtotalNet,
      totalTax: expected.totalTax,
      totalGross: expected.totalGross,
    })
    actual.deliverableRows.forEach((line, index) =>
      expect(line).toMatchObject(expected.itemRows[index]!),
    )
    expect(actual.deliverableRows[0]?.isDeposit).toBe(true)
    expect(
      actual.deliverableRows.every((line) => line.taxRate === expected.itemRows[0]?.taxRate),
    ).toBe(true)
  })
  it("includes deposits in the total and accepts an empty draft", () => {
    const context = {
      profile: resolveCountryProfile("US"),
      currency: "USD",
      taxRate: 0,
      pricesIncludeTax: false,
    }
    expect(
      priceAgreement({
        ...context,
        deliverables: [
          { title: "Deposit", quantity: 1, unitPrice: 300, isDeposit: true },
          { title: "Balance", quantity: 1, unitPrice: 700 },
        ],
      }).totalGross,
    ).toBe(1000)
    expect(priceAgreement({ ...context, deliverables: [] }).totalGross).toBe(0)
  })
})
