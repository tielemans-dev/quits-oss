import { describe, expect, it } from "vitest"
import {
  buildCreditLines,
  computeCreditAvailability,
  creditAmountLine,
  type CreditableInvoiceLine,
  type CreditSelection,
  type PriorCreditLine,
} from "../calculation"

function line(id: string, quantity: number, unitNet: number, taxRate = 25): CreditableInvoiceLine {
  const lineNet = Math.round(quantity * unitNet * 100) / 100
  const lineTax = Math.round(lineNet * taxRate) / 100
  return {
    id,
    description: `Line ${id}`,
    quantity,
    unitPriceNet: unitNet,
    unitPriceGross: Math.round(unitNet * (100 + taxRate)) / 100,
    lineNet,
    lineTax,
    lineGross: Math.round((lineNet + lineTax) * 100) / 100,
    taxRate,
    taxCategory: "standard",
    taxCode: null,
  }
}

const invoiceLines = [line("a", 2, 100), line("b", 3, 33.33)]
const invoiceTotal = invoiceLines.reduce((sum, entry) => sum + Math.round(entry.lineGross * 100), 0) / 100

function build(selection: CreditSelection, prior: PriorCreditLine[] = [], creditedGross?: number) {
  const availability = computeCreditAvailability({
    lines: invoiceLines,
    priorCredits: prior,
    totalGross: invoiceTotal,
    creditedGross:
      creditedGross ?? prior.reduce((sum, credit) => sum + Math.round(credit.lineGross * 100), 0) / 100,
  })
  return buildCreditLines({ availability, selection, taxRate: 25, amountDescription: "Credit for INV-0001" })
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
})
