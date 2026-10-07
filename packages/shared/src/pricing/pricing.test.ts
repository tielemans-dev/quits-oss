import { describe, expect, it } from "vitest"
import { calculateDocument, creditComponents, decimalInput, vatGroupKey } from "./index"
import { calculateDocumentOutputSchema, creditComponentsOutputSchema } from "@quits/contracts/pricing"
import type { VatGroup } from "@quits/contracts/vat"
import Decimal from "decimal.js-light"

const line = (unitPrice: string, sortOrder = 0, quantity = "1") => ({
  quantity, unitPrice, sortOrder, vat: { treatment: "standard" as const, rate: "0.25", country: "DK" },
})
function inclusive(count: number, exchangeRate = "1") {
  return calculateDocument({ currency: exchangeRate === "1" ? "DKK" : "EUR", baseCurrency: "DKK", exchangeRate, pricesIncludeTax: true, lines: Array.from({ length: count }, (_, index) => line("0.01", index)) })
}
function frozen(gross: string, tax: string, exchangeRate = "1") {
  return calculateDocument({ currency: "EUR", baseCurrency: "DKK", exchangeRate, lines: [{ ...line(new Decimal(gross).minus(tax).toString()), vat: { treatment: "standard", rate: new Decimal(tax).div(new Decimal(gross).minus(tax)).toString() } }] }).groups[0]!
}
function credits(group: VatGroup, amounts: string[]) {
  let cumulativeBefore = "0"
  const results = amounts.map((creditedGross) => {
    const result = creditComponents({ group, cumulativeBefore, creditedGross })
    expect(creditComponentsOutputSchema.safeParse(result).success).toBe(true)
    cumulativeBefore = result.cumulativeGross
    return result
  })
  for (const name of ["net", "tax", "gross", "payableRounding", "netBase", "taxBase", "grossBase", "payableRoundingBase"] as const) {
    const reversed = results.reduce((total, credit) => total.plus(credit[name]), new Decimal(0))
    expect(reversed.eq(group[name]), name).toBe(true)
  }
  expect(() => creditComponents({ group, cumulativeBefore, creditedGross: "0.01" })).toThrow(/remaining/)
  return results
}

describe("v2 document calculator", () => {
  it("allocates the two inclusive 0.01 lines' tax and net independently, leaving rounding on the group", () => {
    const result = inclusive(2)
    expect(calculateDocumentOutputSchema.safeParse(result).success).toBe(true)
    expect(result.groups[0]).toMatchObject({ net: "0.02", tax: "0.01", gross: "0.02", payableRounding: "-0.01" })
    expect(result.lines.map(({ net, tax, gross }) => ({ net, tax, gross }))).toEqual([
      { net: "0.01", tax: "0.01", gross: "0.01" }, { net: "0.01", tax: "0.00", gross: "0.01" },
    ])
    const [credit] = credits(result.groups[0]!, ["0.02"])
    expect(credit).toMatchObject({ net: "0.02", tax: "0.01", gross: "0.02", payableRounding: "-0.01" })
  })
  it("allocates three inclusive 0.01 lines and uses sortOrder for ties regardless of input order", () => {
    const result = calculateDocument({ currency: "DKK", pricesIncludeTax: true, lines: [line("0.01", 2), line("0.01", 0), line("0.01", 1)] })
    expect(result.groups[0]).toMatchObject({ net: "0.02", tax: "0.01", gross: "0.03", payableRounding: "0.00" })
    expect(result.lines.map(({ net, tax }) => [net, tax])).toEqual([["0.00", "0.00"], ["0.01", "0.01"], ["0.01", "0.00"]])
  })
  it("rounds line nets first and group tax once for exclusive pricing", () => {
    const result = calculateDocument({ currency: "DKK", lines: [line("0.0149", 1), line("0.0149", 0)] })
    expect(result).toMatchObject({ net: "0.02", tax: "0.01", gross: "0.03", payableRounding: "0.00" })
    expect(result.lines.map((line) => line.tax)).toEqual(["0.00", "0.01"])
  })
  it("reverses tax 0.01, 0.00, 0.01, 0.00 for credits 0.02, 0.02, 0.03, 0.01 on 0.08/0.02", () => {
    const group = frozen("0.08", "0.02")
    expect(group).toMatchObject({ net: "0.06", tax: "0.02", gross: "0.08" })
    expect(credits(group, ["0.02", "0.02", "0.03", "0.01"]).map((credit) => credit.tax)).toEqual(["0.01", "0.00", "0.01", "0.00"])
  })
  it("exhausts tiny tax exactly with five credits of 0.01 on gross 0.05/tax 0.01", () => {
    expect(credits(frozen("0.05", "0.01"), Array(5).fill("0.01")).map((credit) => credit.tax)).toEqual(["0.00", "0.00", "0.01", "0.00", "0.00"])
  })
  it("derives EUR 0.03/0.01/0.04 at 7.45 base net from rounded gross and tax", () => {
    const group = frozen("0.04", "0.01", "7.45")
    expect(group).toMatchObject({ net: "0.03", tax: "0.01", gross: "0.04", grossBase: "0.30", taxBase: "0.07", netBase: "0.23" })
    credits(group, Array(4).fill("0.01"))
  })
  it("includes payable rounding in the base equation for two inclusive EUR 0.01 lines at 7.4567", () => {
    const result = inclusive(2, "7.4567")
    expect(result.groups[0]).toMatchObject({ grossBase: "0.15", taxBase: "0.07", payableRoundingBase: "-0.07", netBase: "0.15" })
    expect(result.debtorBase).toBe("0.15")
    credits(result.groups[0]!, ["0.01", "0.01"])
  })
  it("returns signed base net -0.01 for the third credit at 0.8, never clamping", () => {
    const group = frozen("0.05", "0.01", "0.8")
    expect(group).toMatchObject({ grossBase: "0.04", taxBase: "0.01", netBase: "0.03" })
    const results = credits(group, Array(5).fill("0.01"))
    expect(results[2]).toMatchObject({ grossBase: "0.00", taxBase: "0.01", netBase: "-0.01" })
  })
  it("retains quantity input precision for 0.5 at 100 JPY and uses exponent zero", () => {
    const result = calculateDocument({ currency: "JPY", lines: [{ ...line("100", 0, "0.5"), vat: { treatment: "out_of_scope", rate: "0" } }] })
    expect(result).toMatchObject({ net: "50", gross: "50", calculation: { exponent: 0 } })
    expect(result.lines[0]).toMatchObject({ quantity: "0.5", unitPrice: "100" })
  })
  it("uses half-up for one-decimal frozen components independently of quantity precision", () => {
    const group = { ...frozen("1.00", "0.25"), exponent: 1 as const, baseExponent: 1 as const, net: "0.7", tax: "0.3", gross: "1.0", payableRounding: "0.0", netBase: "0.7", taxBase: "0.3", grossBase: "1.0", payableRoundingBase: "0.0" }
    expect(creditComponents({ group, cumulativeBefore: "0", creditedGross: "0.5" })).toMatchObject({ tax: "0.2", net: "0.3", taxBase: "0.2" })
  })
  it("canonicalizes numeric rates and countries but separates reasons, treatments and countries", () => {
    expect(vatGroupKey({ treatment: "standard", rate: "0.2500", country: "dk" })).toBe(vatGroupKey({ treatment: "standard", rate: "0.25", country: "DK" }))
    const result = calculateDocument({ currency: "DKK", lines: [
      { ...line("1", 0), vat: { treatment: "intra_community", reasonCode: "goods", rate: "0", country: "DE" } },
      { ...line("1", 1), vat: { treatment: "intra_community", reasonCode: "services_b2b", rate: "0", country: "DE" } },
      { ...line("1", 2), vat: { treatment: "intra_community", reasonCode: "goods", rate: "0", country: "FR" } },
    ] })
    expect(result.groups).toHaveLength(3)
  })
  it("returns both asserted document equations, sums base gross per group and subtracts deposits only in document currency", () => {
    const result = calculateDocument({ currency: "EUR", baseCurrency: "DKK", exchangeRate: "7.45", depositApplicationsGross: ["0.01"], lines: [line("0.01", 0), { ...line("0.01", 1), vat: { treatment: "exempt", reasonCode: "health", rate: "0" } }] })
    expect(result.debtorBase).toBe("0.14")
    expect(result.payableGross).toBe("0.01")
    expect(result.equations).toEqual({ document: { left: "0.01", right: "0.01", balanced: true }, base: { left: "0.14", right: "0.14", balanced: true } })
  })
  it("rejects AE at 25%, mixed out_of_scope, standard at zero, invalid precision and exhausted credits", () => {
    const evidence = { buyerVatId: "DE123", viesCheck: { at: "2026-10-07T12:00:00Z", result: "valid" as const }, statementText: "Reverse charge" }
    expect(() => calculateDocument({ currency: "DKK", lines: [{ ...line("1"), evidence, vat: { treatment: "intra_community", reasonCode: "services_b2b", rate: "0.25" } }] })).toThrow()
    expect(() => calculateDocument({ currency: "DKK", lines: [line("1", 0), { ...line("1", 1), vat: { treatment: "out_of_scope", rate: "0" } }] })).toThrow()
    expect(() => calculateDocument({ currency: "DKK", lines: [{ ...line("1"), vat: { treatment: "standard", rate: "0" } }] })).toThrow()
    for (const patch of [{ quantity: "0.1234567" }, { unitPrice: "0.12345" }, { quantity: "1e3" }, { unitPrice: "-1" }])
      expect(() => calculateDocument({ currency: "DKK", lines: [{ ...line("1"), ...patch }] })).toThrow()
    expect(() => calculateDocument({ currency: "KWD", lines: [line("1")] })).toThrow(/precision/)
    expect(() => creditComponents({ group: frozen("0.05", "0.01"), cumulativeBefore: "0.04", creditedGross: "0.02" })).toThrow(/remaining/)
  })
  it("handles empty and zero-value documents", () => {
    for (const lines of [[], [line("0")]]) {
      const result = calculateDocument({ currency: "DKK", lines })
      expect(result).toMatchObject({ net: "0.00", tax: "0.00", gross: "0.00", debtorBase: "0.00" })
    }
  })
})

it("adapts numeric input with full String(number) precision without currency rounding", () => {
  expect(decimalInput(0.5)).toEqual({ value: "0.5", inputPrecision: "number" })
  expect(decimalInput(0.1 + 0.2)).toEqual({ value: "0.30000000000000004", inputPrecision: "number" })
  expect(decimalInput("0.500000")).toEqual({ value: "0.500000", inputPrecision: "string" })
  expect(() => decimalInput(Infinity)).toThrow()
})

it("allocates unequal inclusive weights by independent largest remainders", () => {
  const result = calculateDocument({ currency: "DKK", pricesIncludeTax: true, lines: [line("0.01", 0), line("0.02", 1), line("0.03", 2)] })
  expect(result.groups[0]).toMatchObject({ net: "0.05", tax: "0.01", gross: "0.06", payableRounding: "0.00" })
  expect(result.lines.map(({ net, tax }) => [net, tax])).toEqual([["0.01", "0.00"], ["0.02", "0.00"], ["0.02", "0.01"]])
})
it("uses half-up at both zero and two decimals without rounding the inputs", () => {
  for (const [currency, price, expected] of [["JPY", "1", "1"], ["DKK", "0.01", "0.01"]]) {
    const result = calculateDocument({ currency: currency!, lines: [{ ...line(price!, 0, "0.5"), vat: { treatment: "out_of_scope", rate: "0" } }] })
    expect(result.gross).toBe(expected)
  }
  expect(() => creditComponents({ group: { ...frozen("0.05", "0.01"), tax: "0.005", net: "0.045" }, cumulativeBefore: "0", creditedGross: "0.01" })).toThrow(/Frozen component/)
})
