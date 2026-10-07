import { describe, expect, it } from "vitest"
import { calculateLegacyDocument } from "./index"

describe("calculateLegacyDocument", () => {
  it("computes totals from net prices", () => {
    const result = calculateLegacyDocument({
      items: [{ description: "Design", quantity: 2, unitPrice: 100 }],
      taxRate: 8.25,
      pricesIncludeTax: false,
    })

    expect(result.subtotalNet).toBe(200)
    expect(result.totalTax).toBe(16.5)
    expect(result.totalGross).toBe(216.5)
    expect(result.lines[0]?.unitPriceNet).toBe(100)
    expect(result.lines[0]?.unitPriceGross).toBe(108.25)
    expect(result.lines[0]?.lineNet).toBe(200)
    expect(result.lines[0]?.lineTax).toBe(16.5)
    expect(result.lines[0]?.lineGross).toBe(216.5)
  })

  it("computes totals when prices include tax", () => {
    const result = calculateLegacyDocument({
      items: [{ description: "Consulting", quantity: 1, unitPrice: 125 }],
      taxRate: 25,
      pricesIncludeTax: true,
    })

    expect(result.subtotalNet).toBe(100)
    expect(result.totalTax).toBe(25)
    expect(result.totalGross).toBe(125)
    expect(result.lines[0]?.unitPriceNet).toBe(100)
    expect(result.lines[0]?.unitPriceGross).toBe(125)
    expect(result.lines[0]?.lineNet).toBe(100)
    expect(result.lines[0]?.lineTax).toBe(25)
    expect(result.lines[0]?.lineGross).toBe(125)
  })
})
