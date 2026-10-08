import { describe, expect, expectTypeOf, it } from "vitest"
import { documentViewSchema } from "@quits/contracts/document-view"
import { buildIssuedView, type IssuedMoneySnapshot } from "@quits/shared/documents"
import { calculateDraft } from "@quits/shared/pricing"
import { creditNoteIssuedSchema, invoiceIssuedSchema, type InvoiceIssued } from "../../events/money"
import { creditFixture, invoiceFixture } from "../../accounting/__tests__/fixtures"
import type { InvoiceMoneySnapshot } from "../money-snapshot"

type CreditNoteIssued = Extract<ReturnType<typeof creditNoteIssuedSchema.parse>, { lines: unknown }>

const extras = { status: "sent", locale: "da-DK", timezone: "Europe/Copenhagen" }

describe("buildIssuedView against the app's issued snapshots", () => {
  it("accepts the issued invoice, the invoice money snapshot and the issued credit note", () => {
    expectTypeOf<InvoiceIssued>().toExtend<IssuedMoneySnapshot>()
    expectTypeOf<InvoiceMoneySnapshot>().toExtend<IssuedMoneySnapshot>()
    expectTypeOf<CreditNoteIssued>().toExtend<IssuedMoneySnapshot>()
  })

  it("builds the view of a real InvoiceIssued without repricing it", () => {
    const issued = invoiceIssuedSchema.parse(invoiceFixture())
    const view = buildIssuedView(issued, { ...extras, kind: "invoice" })
    expect(documentViewSchema.parse(view)).toEqual(view)
    expect(view.totals).toEqual({ net: issued.totals.net, tax: issued.totals.tax, gross: issued.totals.gross, payableRounding: issued.totals.payableRounding, payable: issued.totals.gross })
    expect(view.lines).toHaveLength(issued.lines.length)
    expect(view).toMatchObject({ number: { value: "INV-1", preview: null }, dates: { issueDate: "2026-10-07", supplyDate: "2026-10-07", dueDate: "2026-11-07" } })
  })

  it("keeps a real invoice's frozen amounts when they differ from what repricing would give", () => {
    const issued = invoiceIssuedSchema.parse(invoiceFixture({
      pricesIncludeTax: true,
      lines: [{ quantity: "3", unitPrice: "33.33", sortOrder: 0, vat: { treatment: "standard", rate: "0.25", country: "DK" } }],
    }))
    issued.lines[0]!.gross = "100.01"
    issued.totals.gross = "100.01"
    const repriced = calculateDraft({ items: [{ description: "Work", quantity: "3", unitPrice: "33.33", vat: { treatment: "standard", rate: "0.25" } }], taxRate: "25", currency: "DKK", pricesIncludeTax: true })
    expect(repriced.gross).not.toBe("100.01")
    const view = buildIssuedView(issued, { ...extras, kind: "invoice" })
    expect(view.lines[0]).toMatchObject({ gross: "100.01", amount: "100.01" })
    expect(view.totals?.gross).toBe("100.01")
  })

  it("builds the view of a real credit note", () => {
    const credit = creditNoteIssuedSchema.parse(creditFixture())
    expect("lines" in credit).toBe(true)
    if (!("lines" in credit)) return
    const view = buildIssuedView(credit, { ...extras, kind: "creditNote", status: "issued" })
    expect(documentViewSchema.parse(view)).toEqual(view)
    expect(view.vatGroups.map((group) => group.gross)).toEqual(credit.vatGroups.map((group) => group.gross))
    expect(view).toMatchObject({ kind: "creditNote", dates: { dueDate: null }, paymentDetails: null })
  })
})
