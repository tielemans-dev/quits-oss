import { describe, expect, it } from "vitest"
import { calculateDraft } from "@quits/shared/pricing"
import type { FrozenVatGroup } from "@quits/contracts/pricing"
import { buildCreditLines, computeCreditAvailability, type CreditAvailability, type CreditBuildResult } from "../calculation"

const frozen = (gross: string, tax: string, rounding = "0"): FrozenVatGroup => ({
  key: "standard:null:0.25:null", treatment: "standard", reasonCode: null, country: null, rate: "0.25", exponent: 2, baseExponent: 2,
  net: ((Math.round(Number(gross) * 100) - Math.round(Number(tax) * 100) - Math.round(Number(rounding) * 100)) / 100).toFixed(2), tax, gross, payableRounding: rounding,
  netBase: null, taxBase: null, grossBase: null, payableRoundingBase: null,
})
function available(groups: FrozenVatGroup[]): CreditAvailability {
  return { ...computeCreditAvailability({ lines: [], priorCredits: [], totalNet: 0, totalTax: 0, totalGross: 0, creditedNet: 0, creditedTax: 0, creditedGross: 0 }),
    groups: groups.map((original) => ({ original, creditedGross: "0", creditedTax: "0", creditedRounding: "0" })) }
}
function success(result: CreditBuildResult) { if (!result.ok) throw new Error(result.message); return result }
function credit(availability: CreditAvailability, amount: number) {
  const built = success(buildCreditLines({ availability, selection: { mode: "amount", amount }, taxRate: 25, amountDescription: "Credit" }))
  for (const group of built.creditedGroups!) Object.assign(availability.groups!.find((g) => g.original.key === group.original.key)!, {
    creditedGross: group.cumulativeAfter, creditedTax: group.cumulativeTaxAfter, creditedRounding: group.cumulativeRoundingAfter,
  })
  return built
}
describe("v2 frozen-group credits", () => {
  it("reverses tax cumulatively and refuses a fifth credit", () => {
    const a = available([frozen("0.08", "0.02")])
    const results = [0.02, 0.02, 0.03, 0.01].map((amount) => credit(a, amount))
    expect(results.map((r) => r.totalTax)).toEqual([0.01, 0, 0.01, 0])
    expect(results.at(-1)!.creditedGroups![0]).toMatchObject({ cumulativeBefore: "0.07", cumulativeAfter: "0.08", remainingTax: "0.00", remainingNet: "0.00", remainingGross: "0.00", netBase: null })
    expect(buildCreditLines({ availability: a, selection: { mode: "amount", amount: 0.01 }, taxRate: 25, amountDescription: "Credit" })).toMatchObject({ ok: false, code: "fully_credited" })
  })
  it("reverses tiny tax once across five one-cent credits", () => {
    const a = available([frozen("0.05", "0.01")])
    expect(Array.from({ length: 5 }, () => credit(a, 0.01).totalTax)).toEqual([0, 0, 0.01, 0, 0])
  })
  it("allocates a mixed amount by remaining gross and stable largest remainder", () => {
    const standard = frozen("1.25", "0.25")
    const exempt: FrozenVatGroup = { ...frozen("1", "0"), key: "exempt", treatment: "exempt", reasonCode: "health", rate: "0" }
    const a = available([standard, exempt]), b = available([exempt, standard])
    expect(credit(a, 0.9).creditedGroups!.map((g) => [g.original.treatment, g.creditedGross, g.creditedTax])).toEqual([["standard", "0.50", "0.10"], ["exempt", "0.40", "0.00"]])
    expect(credit(a, 0.9).creditedGroups!.map((g) => g.creditedGross)).toEqual(["0.50", "0.40"])
    expect(credit(a, 0.01).creditedGroups![0]!.original.key).toBe(credit(b, 0.01).creditedGroups![0]!.original.key)
  })
  it("fully reverses inclusive rounding of -0.01", () => {
    const c = calculateDraft({ currency: "EUR", pricesIncludeTax: true, taxRate: "25", items: [{ description: "Tiny", quantity: "1", unitPrice: "0.02" }] })
    const built = credit(available(c.groups.map((g) => ({ ...g, netBase: null, taxBase: null, grossBase: null, payableRoundingBase: null }))), 0.02)
    expect([built.subtotalNet, built.totalTax, built.payableRounding, built.totalGross]).toEqual([0.02, 0.01, -0.01, 0.02])
  })
  it("retains signed negative derived net", () => {
    const a = available([frozen("0.05", "0.02", "0.02")])
    credit(a, 0.01)
    const second = credit(a, 0.01)
    expect(second.subtotalNet).toBe(-0.01)
    expect(second.creditedGroups![0]!.creditedNet).toBe("-0.01")
  })
  it("retains the design's negative historical base net at a rate of 0.8", () => {
    const a = available([{ ...frozen("0.05", "0.01"), netBase: "0.03", taxBase: "0.01", grossBase: "0.04", payableRoundingBase: "0" }])
    credit(a, 0.01); credit(a, 0.01)
    expect(credit(a, 0.01).creditedGroups![0]!.netBase).toBe("-0.01")
  })
  it("refuses an exhausting line selection that disagrees with remaining components", () => {
    const group = frozen("0.08", "0.02"), a = available([group])
    Object.assign(a.groups![0]!, { creditedGross: "0.05", creditedTax: "0.02", creditedRounding: "0.00" })
    a.lines = [{ line: { id: "line", description: "Frozen", quantity: 1, unitPriceNet: 0.02, unitPriceGross: 0.03, lineNet: 0.02, lineTax: 0.01, lineGross: 0.03, taxRate: 25, taxCategory: "standard", taxCode: null, groupKey: group.key }, creditedQuantity: 0, remainingQuantity: 1, remainingNet: 0.02, remainingTax: 0.01, remainingGross: 0.03 }]
    expect(buildCreditLines({ availability: a, selection: { mode: "lines", lines: [{ invoiceItemId: "line", quantity: 1 }] }, taxRate: 25, amountDescription: "Credit" })).toMatchObject({ ok: false, code: "line_components_conflict" })
    expect(credit(a, 0.03)).toMatchObject({ subtotalNet: 0.03, totalTax: 0, totalGross: 0.03 })
  })
  it("credits one frozen line and carries its residual into subsequent amount credits", () => {
    const group = frozen("0.08", "0.02"), a = available([group])
    a.lines = [0, 1].map((index) => ({
      line: { id: `line-${index}`, description: "Frozen", quantity: 1, unitPriceNet: 0.03, unitPriceGross: 0.04, lineNet: 0.03, lineTax: index === 0 ? 0.02 : 0, lineGross: index === 0 ? 0.05 : 0.03, taxRate: 25, taxCategory: "standard", taxCode: null, groupKey: group.key },
      creditedQuantity: 0, remainingQuantity: 1, remainingNet: 0.03, remainingTax: index === 0 ? 0.02 : 0, remainingGross: index === 0 ? 0.05 : 0.03,
    }))
    const built = success(buildCreditLines({ availability: a, selection: { mode: "lines", lines: [{ invoiceItemId: "line-0", quantity: 1 }] }, taxRate: 25, amountDescription: "Credit" }))
    expect([built.subtotalNet, built.totalTax, built.totalGross]).toEqual([0.03, 0.02, 0.05])
    expect(built.lines[0]!.invoiceItemId).toBe("line-0")
    const g = built.creditedGroups![0]!
    Object.assign(a.groups![0]!, { creditedGross: g.cumulativeAfter, creditedTax: g.cumulativeTaxAfter, creditedRounding: g.cumulativeRoundingAfter })
    expect(credit(a, 0.03)).toMatchObject({ subtotalNet: 0.03, totalTax: 0, totalGross: 0.03 })
  })
})
