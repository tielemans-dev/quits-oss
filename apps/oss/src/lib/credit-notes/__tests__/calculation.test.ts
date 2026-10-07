import { describe, expect, it } from "vitest"
import { documentFractionDigits } from "../../../domain/documents/pricing"
import {
  buildCreditLines,
  computeCreditAvailability,
  creditAmountLine,
  type CreditableInvoiceLine,
  type CreditSelection,
  type PriorCreditLine,
} from "../calculation"

function line(
  id: string,
  quantity: number,
  unitNet: number,
  taxRate = 25,
  fractionDigits = 2
): CreditableInvoiceLine {
  const scale = 10 ** fractionDigits
  const lineNet = Math.round(quantity * unitNet * scale) / scale
  const lineTax = Math.round((lineNet * taxRate * scale) / 100) / scale
  return {
    id,
    description: `Line ${id}`,
    quantity,
    unitPriceNet: unitNet,
    unitPriceGross: Math.round((unitNet * (100 + taxRate) * scale) / 100) / scale,
    lineNet,
    lineTax,
    lineGross: Math.round((lineNet + lineTax) * scale) / scale,
    taxRate,
    taxCategory: "standard",
    taxCode: null,
  }
}

const invoiceLines = [line("a", 2, 100), line("b", 3, 33.33)]
const cents = (value: number) => Math.round(value * 100)
const sumCents = <T,>(items: readonly T[], pick: (item: T) => number) =>
  items.reduce((sum, item) => sum + cents(pick(item)), 0)
const invoiceTotal = sumCents(invoiceLines, (entry) => entry.lineGross) / 100

function availabilityFor(
  lines: readonly CreditableInvoiceLine[],
  prior: readonly PriorCreditLine[],
  currency?: string
) {
  return computeCreditAvailability({
    lines,
    fractionDigits: currency ? documentFractionDigits(currency) : undefined,
    priorCredits: prior,
    totalNet: sumCents(lines, (entry) => entry.lineNet) / 100,
    totalTax: sumCents(lines, (entry) => entry.lineTax) / 100,
    totalGross: sumCents(lines, (entry) => entry.lineGross) / 100,
    creditedNet: sumCents(prior, (credit) => credit.lineNet) / 100,
    creditedTax: sumCents(prior, (credit) => credit.lineTax) / 100,
    creditedGross: sumCents(prior, (credit) => credit.lineGross) / 100,
  })
}

function build(selection: CreditSelection, prior: PriorCreditLine[] = []) {
  return buildCreditLines({
    availability: availabilityFor(invoiceLines, prior),
    selection,
    taxRate: 25,
    amountDescription: "Credit for INV-0001",
  })
}

function asPrior(result: ReturnType<typeof build>): PriorCreditLine[] {
  if (!result.ok) throw new Error(result.message)
  return result.lines
}

describe("credit note calculation", () => {
  it("credits every line in full", () => {
    const result = build({ mode: "full" })
    expect(result).toMatchObject({ ok: true, totalGross: invoiceTotal })
    expect(result.ok && result.lines.map((entry) => entry.quantity)).toEqual([2, 3])
  })

  it("prorates partial lines and credits the exact remainder last", () => {
    const steps: PriorCreditLine[] = []
    for (let step = 0; step < 3; step++) {
      const result = build({ mode: "lines", lines: [{ invoiceItemId: "b", quantity: 1 }] }, steps)
      steps.push(...asPrior(result))
    }
    const credited = steps.reduce((sum, entry) => sum + Math.round(entry.lineGross * 100), 0) / 100
    expect(credited).toBe(invoiceLines[1].lineGross)
    expect(steps.map((entry) => entry.lineGross)).toEqual([41.66, 41.66, 41.67])
    expect(steps.every((entry) => Math.round((entry.lineNet + entry.lineTax) * 100) === Math.round(entry.lineGross * 100))).toBe(true)
  })

  it("rejects quantities beyond what is left on a line", () => {
    const prior = asPrior(build({ mode: "lines", lines: [{ invoiceItemId: "a", quantity: 1.5 }] }))
    expect(build({ mode: "lines", lines: [{ invoiceItemId: "a", quantity: 1 }] }, prior)).toMatchObject({
      ok: false,
      code: "quantity_exceeds_remaining",
    })
    expect(build({ mode: "lines", lines: [{ invoiceItemId: "a", quantity: 0.5 }] }, prior)).toMatchObject({
      ok: true,
      totalGross: 62.5,
    })
  })

  it("rejects unknown and duplicate lines", () => {
    expect(build({ mode: "lines", lines: [{ invoiceItemId: "zzz", quantity: 1 }] })).toMatchObject({
      code: "unknown_invoice_line",
    })
    expect(
      build({
        mode: "lines",
        lines: [
          { invoiceItemId: "a", quantity: 1 },
          { invoiceItemId: "a", quantity: 1 },
        ],
      })
    ).toMatchObject({ code: "duplicate_invoice_line" })
  })

  it("splits amount credits into net and tax", () => {
    expect(creditAmountLine({ amount: 100, taxRate: 25, description: "x" })).toMatchObject({
      lineNet: 80,
      lineTax: 20,
      lineGross: 100,
      quantity: 1,
      invoiceItemId: null,
    })
    expect(creditAmountLine({ amount: 10, taxRate: 0, description: "x" })).toMatchObject({
      lineNet: 10,
      lineTax: 0,
    })
  })

  it("never credits more than the invoice total", () => {
    expect(build({ mode: "amount", amount: invoiceTotal + 0.01 })).toMatchObject({
      ok: false,
      code: "exceeds_invoice_total",
    })
    const prior = asPrior(build({ mode: "amount", amount: 100 }))
    // Line remainders ignore amount credits, so a full line credit would now exceed the total.
    expect(
      build(
        {
          mode: "lines",
          lines: [
            { invoiceItemId: "a", quantity: 2 },
            { invoiceItemId: "b", quantity: 3 },
          ],
        },
        prior
      )
    ).toMatchObject({ ok: false, code: "exceeds_invoice_total" })
  })

  it("credits the remaining balance as one line after amount credits", () => {
    const prior = asPrior(build({ mode: "amount", amount: 100 }))
    const result = build({ mode: "full" }, prior)
    expect(result).toMatchObject({ ok: true, totalGross: Math.round((invoiceTotal - 100) * 100) / 100 })
    expect(result.ok && result.lines).toHaveLength(1)
  })

  it("reports fully credited invoices", () => {
    const prior = asPrior(build({ mode: "full" }))
    expect(build({ mode: "full" }, prior)).toMatchObject({ ok: false, code: "fully_credited" })
  })

  it("conserves net and tax when an amount credit precedes a full credit", () => {
    const tiny: CreditableInvoiceLine = {
      ...line("t", 1, 0.02, 50),
      lineNet: 0.02,
      lineTax: 0.01,
      lineGross: 0.03,
    }
    const credit = (selection: CreditSelection, prior: PriorCreditLine[]) => {
      const result = buildCreditLines({
        availability: availabilityFor([tiny], prior),
        selection,
        // Rounded line taxes make the nominal rate a poor guide to the invoice's real tax share.
        taxRate: 25,
        amountDescription: "x",
      })
      if (!result.ok) throw new Error(result.message)
      return result
    }
    const first = credit({ mode: "amount", amount: 0.01 }, [])
    const second = credit({ mode: "full" }, first.lines)
    expect(cents(first.subtotalNet) + cents(second.subtotalNet)).toBe(2)
    expect(cents(first.totalTax) + cents(second.totalTax)).toBe(1)
    expect(cents(first.totalGross) + cents(second.totalGross)).toBe(3)
  })

  it("keeps line credits within the net and tax left after amount credits", () => {
    const small: CreditableInvoiceLine = {
      ...line("s", 3, 0.0133),
      lineNet: 0.04,
      lineTax: 0.01,
      lineGross: 0.05,
    }
    const credit = (selection: CreditSelection, prior: PriorCreditLine[]) => {
      const result = buildCreditLines({
        availability: availabilityFor([small], prior),
        selection,
        taxRate: 25,
        amountDescription: "x",
      })
      if (!result.ok) throw new Error(result.message)
      return result
    }
    const first = credit({ mode: "amount", amount: 0.02 }, [])
    expect(first).toMatchObject({ subtotalNet: 0.02, totalTax: 0 })
    // Prorating 2 of 3 units alone would credit net 0.03 and tax 0, more net than is left.
    const second = credit({ mode: "lines", lines: [{ invoiceItemId: "s", quantity: 2 }] }, first.lines)
    expect(second).toMatchObject({ subtotalNet: 0.02, totalTax: 0.01, totalGross: 0.03 })
  })

  it("allocates amount credits against the remaining net and tax", () => {
    const result = build({ mode: "amount", amount: 100 })
    const ratioTax = sumCents(invoiceLines, (entry) => entry.lineTax) / cents(invoiceTotal)
    expect(result.ok && cents(result.totalTax)).toBe(Math.round(10000 * ratioTax))
    expect(result.ok && cents(result.subtotalNet) + cents(result.totalTax)).toBe(10000)
  })

  describe("zero-decimal currencies", () => {
    // 1 x 100 JPY at 25% tax: 125 JPY gross.
    const yenLines = [line("y", 1, 100, 25, 0)]
    const credit = (selection: CreditSelection, prior: PriorCreditLine[] = []) =>
      buildCreditLines({
        availability: availabilityFor(yenLines, prior, "JPY"),
        selection,
        taxRate: 25,
        amountDescription: "x",
      })

    it("rejects amount credits the currency cannot represent", () => {
      expect(credit({ mode: "amount", amount: 0.01 })).toMatchObject({
        ok: false,
        code: "amount_not_representable",
      })
      expect(credit({ mode: "amount", amount: 10.5 })).toMatchObject({
        ok: false,
        code: "amount_not_representable",
      })
      expect(credit({ mode: "amount", amount: 10 })).toMatchObject({ ok: true, totalGross: 10 })
    })

    it("rounds line credits to whole yen and leaves a payable balance", () => {
      const half = credit({ mode: "lines", lines: [{ invoiceItemId: "y", quantity: 0.5 }] })
      if (!half.ok) throw new Error(half.message)
      expect(Number.isInteger(half.totalGross)).toBe(true)
      expect(Number.isInteger(half.subtotalNet)).toBe(true)
      expect(Number.isInteger(half.totalTax)).toBe(true)
      expect(half.lines[0]?.quantity).toBe(0.5)
      expect(half.subtotalNet + half.totalTax).toBe(half.totalGross)

      const rest = credit({ mode: "lines", lines: [{ invoiceItemId: "y", quantity: 0.5 }] }, half.lines)
      if (!rest.ok) throw new Error(rest.message)
      expect(half.totalGross + rest.totalGross).toBe(125)
      expect(half.subtotalNet + rest.subtotalNet).toBe(100)
      expect(half.totalTax + rest.totalTax).toBe(25)
    })

    it("reports the remaining balance in whole yen", () => {
      const first = credit({ mode: "amount", amount: 7 })
      if (!first.ok) throw new Error(first.message)
      const availability = availabilityFor(yenLines, first.lines, "JPY")
      expect(availability.remainingGross).toBe(118)
      expect(Number.isInteger(availability.remainingNet)).toBe(true)
      expect(Number.isInteger(availability.remainingTax)).toBe(true)
    })
  })

  describe("mixed credit sequences", () => {
    // Deterministic PRNG so failures are reproducible.
    function rng(seed: number) {
      let state = seed >>> 0
      return () => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    // Money in minor units of the currency; quantities always in hundredths.
    const currencies = [
      { code: "EUR", fractionDigits: 2 },
      { code: "JPY", fractionDigits: 0 },
    ] as const
    type Currency = (typeof currencies)[number]
    const minorUnit = (currency: Currency) => 10 ** (2 - currency.fractionDigits) // in cents

    function randomInvoice(random: () => number, currency: Currency): CreditableInvoiceLine[] {
      const taxRate = [0, 6, 12.5, 21, 25][Math.floor(random() * 5)]
      const count = 1 + Math.floor(random() * 4)
      const scale = 10 ** currency.fractionDigits
      return Array.from({ length: count }, (_, index) => {
        const quantity = (1 + Math.floor(random() * 500)) / 100
        // Tiny prices make rounding dominate, where conservation bugs show up.
        const unitNet = (1 + Math.floor(random() * (random() < 0.5 ? 10 : 20000))) / scale
        return line(`l${index}`, quantity, unitNet, taxRate, currency.fractionDigits)
      })
    }

    function randomSelection(
      random: () => number,
      availability: ReturnType<typeof availabilityFor>,
      currency: Currency
    ): CreditSelection {
      const roll = random()
      if (roll < 0.15) return { mode: "full" }
      if (roll < 0.6) {
        const unit = minorUnit(currency)
        const remaining = cents(availability.remainingGross) / unit
        const amount = 1 + Math.floor(random() * Math.max(remaining, 1))
        return { mode: "amount", amount: (Math.min(amount, remaining) * unit) / 100 }
      }
      const lines = availability.lines
        .filter((entry) => cents(entry.remainingQuantity) > 0 && random() < 0.7)
        .map((entry) => ({
          invoiceItemId: entry.line.id,
          quantity: Math.max(1, Math.floor(random() * cents(entry.remainingQuantity))) / 100,
        }))
      return lines.length > 0 ? { mode: "lines", lines } : { mode: "full" }
    }

    it("never over-credits net, tax or gross and reaches the invoice totals at full credit", () => {
      for (let seed = 1; seed <= 2000; seed++) {
        const random = rng(seed)
        const currency = currencies[seed % currencies.length]!
        const unit = minorUnit(currency)
        const lines = randomInvoice(random, currency)
        const totals = {
          net: sumCents(lines, (entry) => entry.lineNet),
          tax: sumCents(lines, (entry) => entry.lineTax),
          gross: sumCents(lines, (entry) => entry.lineGross),
        }
        if (totals.gross === 0) continue // nothing to credit on a zero invoice
        const prior: PriorCreditLine[] = []
        let fullyCredited = false

        for (let step = 0; step < 8 && !fullyCredited; step++) {
          const availability = availabilityFor(lines, prior, currency.code)
          for (const remaining of [availability.remainingNet, availability.remainingTax, availability.remainingGross]) {
            expect(cents(remaining) % unit, `seed ${seed} remaining`).toBe(0)
          }
          const selection =
            step === 7 ? { mode: "full" as const } : randomSelection(random, availability, currency)
          const result = buildCreditLines({ availability, selection, taxRate: lines[0].taxRate, amountDescription: "x" })
          if (!result.ok) {
            expect(["exceeds_invoice_total", "nothing_to_credit"], `seed ${seed}`).toContain(result.code)
            continue
          }
          for (const credited of result.lines) {
            expect(cents(credited.lineNet) + cents(credited.lineTax), `seed ${seed}`).toBe(cents(credited.lineGross))
            for (const amount of [credited.lineNet, credited.lineTax, credited.lineGross]) {
              expect(cents(amount) % unit, `seed ${seed} ${currency.code}`).toBe(0)
            }
          }
          prior.push(...result.lines)

          const credited = {
            net: sumCents(prior, (entry) => entry.lineNet),
            tax: sumCents(prior, (entry) => entry.lineTax),
            gross: sumCents(prior, (entry) => entry.lineGross),
          }
          expect(credited.net, `seed ${seed} net`).toBeLessThanOrEqual(totals.net)
          expect(credited.tax, `seed ${seed} tax`).toBeLessThanOrEqual(totals.tax)
          expect(credited.gross, `seed ${seed} gross`).toBeLessThanOrEqual(totals.gross)
          expect(credited.net, `seed ${seed} net`).toBeGreaterThanOrEqual(0)
          expect(credited.tax, `seed ${seed} tax`).toBeGreaterThanOrEqual(0)

          if (credited.gross === totals.gross) {
            expect(credited, `seed ${seed}`).toEqual(totals)
            fullyCredited = true
          }
        }

        expect(fullyCredited, `seed ${seed}`).toBe(true)
      }
    })
  })
})
