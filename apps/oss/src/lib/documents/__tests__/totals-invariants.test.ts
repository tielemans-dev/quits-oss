import { describe, expect, it } from "vitest"
import { Prisma } from "../../../../generated/prisma/client"
import { priceDocumentV2 } from "../../../domain/documents/pricing"
import { documentVatSummary, payableRoundingOf } from "../../../domain/documents/vat-summary"
import { lineAmounts, priceBasis } from "../line-amounts"
import { buildTotals } from "../totals"

const D = Prisma.Decimal
const sum = (values: string[]) => values.reduce((total, value) => total.plus(value), new D(0))

/** mulberry32: a small seeded generator, so a failure names a reproducible document. */
function generator(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Vat = { treatment: "standard" | "exempt"; rate: string; reasonCode?: string }
const vats: Vat[] = [
  { treatment: "standard", rate: "0.25" },
  { treatment: "standard", rate: "0.05" },
  { treatment: "standard", rate: "0.125" },
  { treatment: "exempt", rate: "0", reasonCode: "other" },
]

/** A document priced once and stored, the way the database holds it. */
function generate(random: () => number) {
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!
  const currency = pick(["DKK", "JPY", "USD"])
  const pricesIncludeTax = random() < 0.5
  const count = 1 + Math.floor(random() * 6)
  const items = Array.from({ length: count }, (_, index) => {
    const vat = pick(vats)
    const unitPrice = currency === "JPY" ? String(1 + Math.floor(random() * 100000)) : ((1 + Math.floor(random() * 500000)) / 100).toFixed(2)
    return {
      description: `Line ${index}`,
      quantity: pick(["1", "2", "3", "7", "0.5", "12.5", "1.75"]),
      unitPrice,
      vat: { treatment: vat.treatment, rate: vat.rate, country: null, reasonCode: vat.reasonCode ?? null },
    }
  })
  const priced = priceDocumentV2({ items: items as never, taxRate: "25", pricesIncludeTax, currency })
  return {
    currency, pricesIncludeTax,
    subtotalNet: new D(priced.subtotalNet), totalTax: new D(priced.totalTax), totalGross: new D(priced.totalGross),
    items: priced.itemRows.map((row) => ({
      ...row,
      unitPriceNet: new D(row.unitPriceNet), unitPriceGross: new D(row.unitPriceGross),
      lineNet: new D(row.lineNet), lineTax: new D(row.lineTax), lineGross: new D(row.lineGross),
      taxRate: new D(row.taxRate), vatReasonCode: row.vatReasonCode ?? null, vatCountry: row.vatCountry ?? null,
    })),
  }
}

describe("totals of generated documents", () => {
  it("adds up exactly on every surface for 2,000 seeded multi-rate documents", () => {
    const random = generator(20261008)
    let rounded = 0
    let multiple = 0
    for (let index = 0; index < 2000; index++) {
      const document = generate(random)
      const where = `document ${index} (${document.currency}, ${document.pricesIncludeTax ? "gross" : "net"}, ${document.items.length} lines)`
      const exponent = document.currency === "JPY" ? 0 : 2

      // The lines add up to the subtotal on a net basis and to the total on a gross one.
      const basis = priceBasis(document.pricesIncludeTax)
      const printedLines = document.items.map((line) => lineAmounts(basis, line).amount.toFixed(exponent))
      expect(sum(printedLines).toFixed(exponent), `${where}: lines`).toBe((basis === "net" ? document.subtotalNet : document.totalGross).toFixed(exponent))

      // The rows account for the stored subtotal and tax, so every document shows its rows.
      const summary = documentVatSummary(document)
      expect(summary.vatRows, `${where}: rows`).toBeDefined()
      expect(sum(summary.vatRows!.map((row) => row.net)).toFixed(exponent), `${where}: row bases`).toBe(document.subtotalNet.toFixed(exponent))
      expect(sum(summary.vatRows!.map((row) => row.tax)).toFixed(exponent), `${where}: row tax`).toBe(document.totalTax.toFixed(exponent))
      expect(summary.rounding, `${where}: rounding`).toBe(payableRoundingOf(document))
      expect(new D(summary.rounding).abs().lte(new D(10).pow(-exponent).times(summary.vatRows!.length)), `${where}: rounding is below a unit per rate`).toBe(true)
      if (!new D(summary.rounding).isZero()) rounded++
      if (summary.vatRows!.length > 1) multiple++

      // What every surface prints: subtotal + VAT rows + rounding = total, whatever the locale.
      for (const locale of ["da-DK", "en-US"]) {
        const totals = buildTotals({
          basis, subtotal: document.subtotalNet.toFixed(exponent), taxAmount: document.totalTax.toFixed(exponent), total: document.totalGross.toFixed(exponent),
          vatRows: summary.vatRows, rounding: summary.rounding, currency: document.currency, locale,
        })
        expect(sum(totals.lines.map((line) => line.amount)).toFixed(exponent), `${where}: printed rows (${locale})`).toBe(totals.total.amount)
        expect(totals.lines[0]!.kind).toBe("subtotal")
        expect(totals.lines.filter((line) => line.kind === "rounding").length).toBe(new D(summary.rounding).isZero() ? 0 : 1)
      }
    }
    // The loop must exercise what it claims to: rounding and several rates both occur.
    expect(rounded).toBeGreaterThan(100)
    expect(multiple).toBeGreaterThan(500)
  })

  it("falls back to the single tax amount, still adding up, when the rows cannot be shown", () => {
    const totals = buildTotals({ basis: "gross", subtotal: "8.10", taxAmount: "2.03", total: "10.12", vatRows: undefined, rounding: "-0.01", currency: "DKK", locale: "da-DK" })
    expect(totals.lines.map((line) => [line.label, line.amount])).toEqual([["Subtotal ekskl. moms", "8.10"], ["Moms", "2.03"], ["Afrunding", "-0.01"]])
    expect(totals.total).toMatchObject({ label: "Total inkl. moms", amount: "10.12" })
  })
})
