import { describe, expect, it } from "vitest"
import { obligationPosition, type PositionInput } from "../position"
import { accepted, agreementObligation, plan, shareStep } from "./fixtures"

const obligation = agreementObligation({ agreementId: "agreement", acceptedOn: "2026-10-01", lines: [{ id: "work", net: "80" }] })
const schedule = plan(obligation, {
  kind: "advance_then_billing", application: "next_sale_invoice",
  steps: [shareStep("all", "10000", accepted)],
  advances: [{ advanceId: "advance", label: "Advance", grossMinor: "1000", trigger: accepted, dueInDays: 7 }],
})
const invoice = { invoiceId: "invoice", stepId: "all", grossMinor: "10000", taxMinor: "2000", creditedMinor: "0" }
const receipt: PositionInput["receipts"][number] = { receiptId: "receipt", method: "bank_transfer", grossMinor: "1000", for: { kind: "advance", advanceId: "advance" } }
const base: PositionInput = { obligation, plan: schedule, saleInvoices: [invoice], receipts: [receipt], applications: [], refunds: [] }
const position = (input: PositionInput) => {
  const result = obligationPosition(input)
  if (!result.ok) throw new Error(JSON.stringify(result.refusals))
  const p = result.position
  // Every successful snapshot must conserve both the advance liability and the whole obligation.
  expect(p.advanceReceivedMinor).toBe(p.advanceAppliedMinor + p.advanceRefundedMinor + p.advanceAvailableMinor)
  expect(p.advanceAvailableMinor).toBeGreaterThanOrEqual(0n)
  expect(p.remainingMinor).toBe(p.uninvoicedMinor + p.receivableMinor - p.invoices.reduce((sum, item) => sum + item.overpaidMinor, 0n) - p.advanceAvailableMinor)
  return p
}
const refused = (input: PositionInput, code: string) => {
  const result = obligationPosition(input)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.refusals.map((item) => item.code)).toContain(code)
}

describe("invoice corrections and obligation reductions", () => {
  it("keeps the unpaid replacement debt and reverses the original tax", () => {
    const p = position({ ...base, receipts: [], saleInvoices: [{ ...invoice, invoiceId: "original", creditedMinor: "10000" }, invoice] })
    expect(p).toMatchObject({ payableMinor: 10000n, remainingMinor: 10000n, receivableMinor: 10000n, uninvoicedMinor: 0n, saleTaxMinor: 2000n })
  })

  it("keeps a corrected but not yet replaced amount uninvoiced", () => {
    expect(position({ ...base, receipts: [], saleInvoices: [{ ...invoice, creditedMinor: "10000" }] }))
      .toMatchObject({ remainingMinor: 10000n, uninvoicedMinor: 10000n, receivableMinor: 0n, saleTaxMinor: 0n })
  })

  it("reduces debt only by the explicit concession, including partial credits", () => {
    const credited = { ...invoice, creditedMinor: "2500", creditedTaxMinor: "500", obligationReductionMinor: "2500" }
    expect(position({ ...base, receipts: [], saleInvoices: [credited] }))
      .toMatchObject({ obligationReductionMinor: 2500n, payableMinor: 7500n, receivableMinor: 7500n, remainingMinor: 7500n, uninvoicedMinor: 0n, saleTaxMinor: 1500n })
    expect(position({ ...base, receipts: [], saleInvoices: [{ ...credited, obligationReductionMinor: "0" }] }))
      .toMatchObject({ payableMinor: 10000n, receivableMinor: 7500n, remainingMinor: 10000n, uninvoicedMinor: 2500n })
    expect(position({ ...base, receipts: [], saleInvoices: [{ ...invoice, creditedMinor: "10000", obligationReductionMinor: "10000" }] }))
      .toMatchObject({ payableMinor: 0n, remainingMinor: 0n, uninvoicedMinor: 0n, saleTaxMinor: 0n })
  })

  it("refuses rebilling forgiven debt", () => {
    refused({ ...base, saleInvoices: [{ ...invoice, invoiceId: "original", creditedMinor: "10000", obligationReductionMinor: "10000" }, invoice] }, "double_counted")
  })

  it("keeps payment on the corrected invoice visible as overpayment without losing replacement debt", () => {
    const paid: PositionInput["receipts"][number] = { receiptId: "paid", method: "card", grossMinor: "10000", for: { kind: "invoice", invoiceId: "original" } }
    const p = position({ ...base, receipts: [paid], saleInvoices: [{ ...invoice, invoiceId: "original", creditedMinor: "10000" }, invoice] })
    expect(p).toMatchObject({ remainingMinor: 0n, receivableMinor: 10000n })
    expect(p.invoices[0]?.overpaidMinor).toBe(10000n)
  })

  it.each([
    { taxMinor: "10001" }, { creditedMinor: "10001" }, { obligationReductionMinor: "1" },
    { creditedMinor: "1000" }, { creditedTaxMinor: "1" },
    { creditedMinor: "1000", creditedTaxMinor: "1001" },
    { creditedMinor: "10000", creditedTaxMinor: "0" },
    { creditedMinor: "9000", creditedTaxMinor: "0" },
  ])("rejects inconsistent invoice components %j", (change) => {
    refused({ ...base, saleInvoices: [{ ...invoice, ...change }] }, "invalid_position")
  })
})

describe("position identity, reference and amount validation", () => {
  it.each([
    { applications: [{ receiptId: "receipt", invoiceId: "missing", grossMinor: "1000" }] },
    { applications: [{ receiptId: "missing", invoiceId: "invoice", grossMinor: "1000" }] },
    { refunds: [{ receiptId: "missing", grossMinor: "2000" }] },
    { receipts: [{ ...receipt, for: { kind: "invoice" as const, invoiceId: "missing" } }] },
    { receipts: [{ ...receipt, for: { kind: "advance" as const, advanceId: "missing" } }] },
  ])("rejects missing reference %j", (change) => refused({ ...base, ...change }, "stale_plan_reference"))

  it.each([
    { saleInvoices: [invoice, invoice] }, { receipts: [receipt, receipt] },
    { applications: Array.from({ length: 2 }, () => ({ receiptId: "receipt", invoiceId: "invoice", grossMinor: "100" })) },
    { refunds: Array.from({ length: 2 }, () => ({ receiptId: "receipt", grossMinor: "100" })) },
  ])("rejects duplicate identities %j", (change) => refused({ ...base, ...change }, "duplicate_position_entry"))

  it.each(["-1", "1.5", "01", "", "NaN", "1e3"])("rejects malformed minor amount %j before arithmetic", (value) => {
    refused({ ...base, receipts: [{ ...receipt, grossMinor: value }] }, "invalid_position")
    refused({ ...base, applications: [{ receiptId: "receipt", invoiceId: "invoice", grossMinor: value }] }, "invalid_position")
    refused({ ...base, refunds: [{ receiptId: "receipt", grossMinor: value }] }, "invalid_position")
    for (const key of ["grossMinor", "taxMinor", "creditedMinor", "creditedTaxMinor", "obligationReductionMinor"])
      refused({ ...base, saleInvoices: [{ ...invoice, [key]: value }] }, "invalid_position")
  })

  it("validates the referenced obligation version, currency and plan totals", () => {
    const other = agreementObligation({ agreementId: "foreign", acceptedOn: "2026-10-01", lines: [{ id: "work", net: "80" }] })
    refused({ ...base, plan: { ...schedule, obligation: other.ref } }, "obligation_mismatch")
    refused({ ...base, obligation: agreementObligation({ agreementId: "agreement", acceptedOn: "2026-10-01", lines: [{ id: "work", net: "80" }], revision: 2 }) }, "stale_obligation_version")
    refused({ ...base, plan: { ...schedule, currency: "EUR" } }, "currency_mismatch")
    refused({ ...base, plan: { ...schedule, version: 0 } }, "invalid_position")
    refused({ ...base, plan: { ...schedule, arrangement: { kind: "billing_steps", steps: [shareStep("all", "9999", accepted)] } } }, "total_mismatch")
  })
})

describe("advance conservation", () => {
  it("conserves a receipt split between application, refund and available money", () => {
    expect(position({ ...base, applications: [{ receiptId: "receipt", invoiceId: "invoice", grossMinor: "400" }], refunds: [{ receiptId: "receipt", grossMinor: "300" }] }))
      .toMatchObject({ advanceAvailableMinor: 300n, receivableMinor: 9600n, remainingMinor: 9300n })
  })

  it("conserves multiple receipts with an unapplied overpayment", () => {
    expect(position({ ...base, receipts: [receipt, { ...receipt, receiptId: "extra", grossMinor: "15000" }],
      applications: [{ receiptId: "extra", invoiceId: "invoice", grossMinor: "10000" }], refunds: [{ receiptId: "receipt", grossMinor: "1000" }] }))
      .toMatchObject({ advanceAvailableMinor: 5000n, remainingMinor: -5000n, receivableMinor: 0n })
  })

  it("bounds combined refunds and applications by each receipt", () => {
    refused({ ...base, applications: [{ receiptId: "receipt", invoiceId: "invoice", grossMinor: "800" }], refunds: [{ receiptId: "receipt", grossMinor: "300" }] }, "over_application")
  })

  it("does not consume advance money on a paid or fully credited invoice", () => {
    const application = { receiptId: "receipt", invoiceId: "invoice", grossMinor: "1000" }
    refused({ ...base, applications: [application], receipts: [receipt, { ...receipt, receiptId: "paid", grossMinor: "9500", for: { kind: "invoice", invoiceId: "invoice" } }] }, "over_application")
    refused({ ...base, applications: [application], saleInvoices: [{ ...invoice, creditedMinor: "10000" }] }, "over_application")
  })

  it("does not refund or apply a direct invoice payment as advance money", () => {
    const direct: PositionInput = { ...base, receipts: [{ ...receipt, for: { kind: "invoice", invoiceId: "invoice" } }] }
    refused({ ...direct, refunds: [{ receiptId: "receipt", grossMinor: "100" }] }, "over_application")
    refused({ ...direct, applications: [{ receiptId: "receipt", invoiceId: "invoice", grossMinor: "100" }] }, "over_application")
  })
})
