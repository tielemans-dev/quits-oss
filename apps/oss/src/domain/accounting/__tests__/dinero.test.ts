import { describe, expect, it } from "vitest"
import { dineroBookingPayload, dineroProvider, type DineroSettings } from "../dinero"
import type { AccountingEvent } from "../provider"
import { creditFixture, invoiceFixture, refusalFixtures } from "./fixtures"

const contactGuid = "11111111-1111-4111-8111-111111111111"
const documentGuid = "22222222-2222-4222-8222-222222222222"
const invoiceGuid = "33333333-3333-4333-8333-333333333333"
function fixture(eu = false) {
  const invoice = invoiceFixture({ lines: [{ quantity: "2", unitPrice: "50.05", sortOrder: 0,
    vat: eu ? { treatment: "intra_community", reasonCode: "services_b2b", rate: "0", country: "DE" } : { treatment: "standard", rate: "0.25", country: "DK" },
    ...(eu ? { evidence: { buyerVatId: "DE123456789", viesCheck: { at: "2026-10-07T12:00:00.000Z", result: "valid" as const }, statementText: "Reverse charge" } } : {}),
  }] })
  invoice.buyer.country = eu ? "DE" : "DK"
  const settings: DineroSettings = { contactGuid, documentGuid, invoiceLinks: { invoice: invoiceGuid },
    vatMappings: { [invoice.vatGroups[0]!.key]: { accountNumber: eu ? 1100 : 1000 } } }
  const event: AccountingEvent = { deliveryId: "delivery-1", type: "invoice.issued", schemaVersion: 1, payload: invoice }
  return { invoice, settings, event }
}
function paymentFixture() {
  const settings: DineroSettings = { ...fixture().settings, payment: { paymentId: "payment-1", invoiceNumber: "INV-1",
    invoiceGuid, timestamp: "00000000020A5EA8", depositAccountNumber: 55000,
    paymentDate: "2026-10-08", baseAmount: "125.13", settlement: "gross_no_fees" } }
  const event: AccountingEvent = { deliveryId: "payment-delivery", type: "payment.recorded", schemaVersion: 1,
    payload: { paymentId: "payment-1", number: "INV-1", amount: "125.13", currency: "DKK", method: "bank_transfer", balanceDue: "0.00", paymentStatus: "paid" } }
  return { settings, event }
}
describe("Dinero pure preparation", () => {
  it.each([false, true])("maps frozen amounts and explicit accounts, EU reverse charge=%s", eu => {
    const { event, settings, invoice } = fixture(eu)
    const before = JSON.stringify({ event, settings })
    expect(dineroProvider.map(event, settings)).toEqual({ status: "prepared", idempotencyKey: "delivery-1",
      expectedTotals: { net: "100.10", tax: eu ? "0.00" : "25.03", gross: eu ? "100.10" : "125.13" },
      payload: { path: "/invoices", body: { Guid: documentGuid, ContactGuid: contactGuid, Currency: "DKK", Date: invoice.issueDate,
        ExternalReference: "delivery-1", Comment: "INV-1", ShowLinesInclVat: false,
        PaymentConditionType: "Netto", PaymentConditionNumberOfDays: 31,
        ProductLines: [{ Description: "Work", AccountNumber: eu ? 1100 : 1000, Quantity: 1, BaseAmountValue: 100.1, Discount: 0, Unit: "parts", LineType: "Product" }] } } })
    expect(dineroProvider.map(event, settings)).toEqual(dineroProvider.map(event, settings))
    expect(JSON.stringify({ event, settings })).toBe(before)
  })
  it("uses a dedicated credit note with positive lines and a corrected invoice link", () => {
    const { invoice, settings } = fixture()
    const event = { deliveryId: "credit-delivery", type: "credit_note.issued", schemaVersion: 2, payload: creditFixture(invoice) }
    const result = dineroProvider.map(event, settings)
    expect(result).toMatchObject({ status: "prepared", expectedTotals: { net: "-100.10", tax: "-25.03", gross: "-125.13" },
      payload: { path: "/sales/creditnotes", body: { CreditNoteFor: invoiceGuid, ProductLines: [{ Quantity: 1, BaseAmountValue: 100.1 }] } } })
    if (result.status === "prepared") expect(result.payload.body).not.toHaveProperty("PaymentConditionType")
    expect(dineroProvider.map(event, { ...settings, invoiceLinks: {} })).toMatchObject({ status: "refused", code: "missing_mapping" })
    expect(dineroBookingPayload("00000000020A5EA8")).toEqual({ Timestamp: "00000000020A5EA8" })
    expect(() => dineroBookingPayload("")).toThrow("Missing Dinero timestamp")
  })
  it("maps one gross payment to the booked invoice without adding VAT or fees", () => {
    const { event, settings } = paymentFixture()
    const before = JSON.stringify({ event, settings })
    expect(dineroProvider.map(event, settings)).toEqual({ status: "prepared", idempotencyKey: "payment-delivery",
      expectedTotals: { net: "0.00", tax: "0.00", gross: "125.13" }, payload: { path: `/invoices/${invoiceGuid}/payments`,
        body: { Timestamp: "00000000020A5EA8", DepositAccountNumber: 55000, PaymentDate: "2026-10-08", Amount: 125.13,
          RemainderIsFee: false, Description: "INV-1", ExternalReference: "payment-delivery" } } })
    expect(JSON.stringify({ event, settings })).toBe(before)
    expect(dineroProvider.map(event, settings)).toEqual(dineroProvider.map(event, settings))
  })
  it.each([undefined, { ...paymentFixture().settings.payment!, paymentId: "other" },
    { ...paymentFixture().settings.payment!, paymentDate: "2026-02-30" }, { ...paymentFixture().settings.payment!, baseAmount: "125.12" },
    { ...paymentFixture().settings.payment!, timestamp: "" }, { ...paymentFixture().settings.payment!, invoiceGuid: "invalid" },
    { ...paymentFixture().settings.payment!, depositAccountNumber: 0 }])("refuses missing or inconsistent payment evidence", payment => {
    const { event, settings } = paymentFixture()
    expect(dineroProvider.map(event, { ...settings, payment }).status).toBe("refused")
  })
  it.each([ { amount: "0" }, { amount: "-1" }, { amount: "1.001" }, { amount: "1000000000000000000" },
    { currency: "EUR" }, { overpaidBy: "1.00" }, { balanceDue: "-1" } ])("refuses unsupported payment $amount $currency", change => {
    const { event, settings } = paymentFixture()
    expect(dineroProvider.map({ ...event, payload: { ...event.payload as object, ...change } }, settings).status).toBe("refused")
  })
  it("prepares partial receipts without writing off the remainder and rejects unversioned payments", () => {
    const { event, settings } = paymentFixture()
    const partial = { ...event, payload: { ...event.payload as object, amount: "25.03", balanceDue: "100.10", paymentStatus: "partial" } }
    expect(dineroProvider.map(partial, { ...settings, payment: { ...settings.payment!, baseAmount: "25.03" } })).toMatchObject({ status: "prepared",
      expectedTotals: { net: "0.00", tax: "0.00", gross: "25.03" }, payload: { body: { Amount: 25.03, RemainderIsFee: false } } })
    expect(dineroProvider.map({ ...event, schemaVersion: 2 }, settings)).toMatchObject({ status: "refused", code: "not_postable" })
  })
  it("refuses invalid draft identities and oversized external references", () => {
    const { event, settings } = fixture()
    for (const change of [{ documentGuid: "invalid" }, { contactGuid: "invalid" }])
      expect(dineroProvider.map(event, { ...settings, ...change })).toMatchObject({ status: "refused", code: "missing_mapping" })
    expect(dineroProvider.map({ ...event, deliveryId: "x".repeat(129) }, settings)).toMatchObject({ status: "refused", code: "missing_mapping" })
  })
  it.each(refusalFixtures.filter(f => f.name !== "payment.recorded"))("preserves the ledger refusal for $name", ({ event, code }) => {
    expect(dineroProvider.map({ ...event, deliveryId: "delivery-1" }, fixture().settings)).toMatchObject({ status: "refused", code })
  })
  it("preserves line order and refuses absent account mappings", () => {
    const { invoice, event, settings } = fixture()
    const multi = invoiceFixture({ lines: [0, 1].map(sortOrder => ({ quantity: "1", unitPrice: "100", sortOrder, vat: invoice.lines[0]!.vat })) })
    multi.lines.forEach((line, i) => { line.description = `Work ${i}` })
    expect(dineroProvider.map({ ...event, payload: multi }, settings)).toMatchObject({ status: "prepared",
      payload: { body: { ProductLines: [{ Description: "Work 0" }, { Description: "Work 1" }] } } })
    expect(dineroProvider.map(event, { ...settings, vatMappings: {} })).toMatchObject({ status: "refused", code: "missing_mapping" })
  })
  it("refuses FX, unrepresentable money, rounding differences and invalid due dates", () => {
    const { event, settings, invoice } = fixture()
    const huge = invoiceFixture({ lines: [{ quantity: "1000000", unitPrice: "1000000000000", sortOrder: 0, vat: invoice.lines[0]!.vat }] })
    expect(dineroProvider.map({ ...event, payload: huge }, settings)).toMatchObject({ status: "refused", code: "amount_not_representable" })
    const inclusive = invoiceFixture({ pricesIncludeTax: true, lines: [0, 1].map(sortOrder => ({ quantity: "1", unitPrice: "0.03", sortOrder, vat: invoice.lines[0]!.vat })) })
    for (const payload of [invoiceFixture({ currency: "EUR" }), inclusive, { ...invoice, dueDate: "2026-10-06" }])
      expect(dineroProvider.map({ ...event, payload }, settings)).toMatchObject({ status: "refused", code: "unsupported_document" })
  })
})
