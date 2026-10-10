import { describe, expect, it } from "vitest"
import { calculateDraft } from "@quits/shared/pricing"
import { formatMinor, minorFromAmount, resolveRatioShares, shareComponents, sumMinor } from "../amounts"

describe("plan amounts", () => {
  it("resolves ratios by cumulative half-up rounding so shares always total exactly", () => {
    expect(resolveRatioShares(10_000n, [3333, 3333, 3334])).toEqual([3333n, 3333n, 3334n])
    expect(resolveRatioShares(2_500_000n, [5000, 5000])).toEqual([1_250_000n, 1_250_000n])
    expect(resolveRatioShares(2_500_000n, [3000, 7000])).toEqual([750_000n, 1_750_000n])
    // 0.05 DKK in thirds: cumulative 1.6667 -> 2, 3.3333 -> 3, 5.
    expect(resolveRatioShares(5n, [3333, 3333, 3334])).toEqual([2n, 1n, 2n])
    for (const total of [1n, 7n, 99_999n, 123_456_789n]) expect(sumMinor(resolveRatioShares(total, [1, 4999, 2500, 2500]))).toBe(total)
    expect(() => resolveRatioShares(100n, [5000, 4000])).toThrow("10000")
  })

  it("keeps currency precision: no sub-minor input, exponent from the currency", () => {
    expect(minorFromAmount("12500.00", "DKK")).toBe("1250000")
    expect(() => minorFromAmount("0.005", "DKK")).toThrow("sub-minor")
    expect(minorFromAmount("1200", "JPY")).toBe("1200")
    expect(() => minorFromAmount("1.5", "JPY")).toThrow("sub-minor")
    expect(() => minorFromAmount("1.000", "KWD")).toThrow("precision")
    expect(formatMinor(1_250_000n, "DKK")).toBe("12500.00")
    expect(formatMinor("7", "DKK")).toBe("0.07")
    expect(formatMinor(1200n, "JPY")).toBe("1200")
  })

  it("splits a mixed-rate obligation into shares that reproduce every frozen VAT component", () => {
    const priced = calculateDraft({
      currency: "DKK", pricesIncludeTax: false, taxRate: "25",
      items: [
        { description: "Design", quantity: "1", unitPrice: "10000.01" },
        { description: "Exempt training", quantity: "1", unitPrice: "3333.33", vat: { treatment: "exempt", rate: "0", reasonCode: "education" } },
      ],
    })
    const total = BigInt(minorFromAmount(priced.gross, "DKK"))
    const shares = resolveRatioShares(total, [3333, 3333, 3334])
    const parts = shareComponents(priced.groups, shares, "DKK")
    expect(parts.map((part) => part.grossMinor)).toEqual(shares)
    for (const part of parts) expect(part.netMinor + part.taxMinor + part.payableRoundingMinor).toBe(part.grossMinor)
    expect(sumMinor(parts.map((part) => part.taxMinor)).toString()).toBe(minorFromAmount(priced.tax, "DKK"))
    expect(sumMinor(parts.map((part) => part.netMinor)).toString()).toBe(minorFromAmount(priced.net, "DKK"))
    for (const group of priced.groups) {
      const parts_ = parts.flatMap((part) => part.groups.filter((item) => item.key === group.key))
      expect(sumMinor(parts_.map((item) => item.grossMinor)).toString()).toBe(minorFromAmount(group.gross, "DKK"))
      expect(sumMinor(parts_.map((item) => item.taxMinor)).toString()).toBe(minorFromAmount(group.tax, "DKK"))
    }
  })

  it("carries inclusive-price payable rounding through the shares exactly", () => {
    const priced = calculateDraft({ currency: "DKK", pricesIncludeTax: true, taxRate: "25", items: [{ description: "a", quantity: "1", unitPrice: "0.01" }, { description: "b", quantity: "1", unitPrice: "0.01" }] })
    expect(priced.payableRounding).toBe("-0.01")
    const parts = shareComponents(priced.groups, [1n, 1n], "DKK")
    expect(sumMinor(parts.map((part) => part.payableRoundingMinor))).toBe(-1n)
    expect(sumMinor(parts.map((part) => part.taxMinor))).toBe(1n)
    expect(() => shareComponents(priced.groups, [1n, 2n], "DKK")).toThrow("Shares must total")
  })
})
