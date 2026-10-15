import { describe, expect, it } from "vitest"
import { economicBookingPayload, economicProvider, type EconomicSettings } from "../economic"
import type { AccountingEvent } from "../provider"
import { creditFixture, invoiceFixture, refusalFixtures } from "./fixtures"

function fixture(eu = false) {
  const invoice = invoiceFixture({ lines: [{ quantity: "2", unitPrice: "50.05", sortOrder: 0,
    vat: eu ? { treatment: "intra_community", reasonCode: "services_b2b", rate: "0", country: "DE" } : { treatment: "standard", rate: "0.25", country: "DK" },
    ...(eu ? { evidence: { buyerVatId: "DE123456789", viesCheck: { at: "2026-10-07T12:00:00.000Z", result: "valid" as const }, statementText: "Reverse charge" } } : {}),
  }] })
  invoice.buyer = { ...invoice.buyer, company: "Fixture buyer", country: eu ? "DE" : "DK" }
  const settings: EconomicSettings = { customerNumber: 42, layoutNumber: 1, paymentTermsNumber: 3,
    vatMappings: { [invoice.vatGroups[0]!.key]: { productNumber: eu ? "EU-SERVICES" : "DK-SALES", vatZoneNumber: eu ? 2 : 1 } } }
  const event: AccountingEvent = { deliveryId: "delivery-1", type: "invoice.issued", schemaVersion: 1, payload: invoice }
  return { invoice, settings, event }
}

describe("e-conomic pure preparation", () => {
  it.each([false, true])("maps frozen amounts and explicit VAT routing, EU reverse charge=%s", eu => {
    const { event, settings, invoice } = fixture(eu)
    const before = JSON.stringify({ event, settings })
    expect(economicProvider.map(event, settings)).toEqual({ status: "prepared", idempotencyKey: "delivery-1",
      expectedTotals: { net: "100.10", tax: eu ? "0.00" : "25.03", gross: eu ? "100.10" : "125.13" },
      payload: { currency: "DKK", date: invoice.issueDate, dueDate: invoice.dueDate,
        customer: { customerNumber: 42 }, layout: { layoutNumber: 1 }, paymentTerms: { paymentTermsNumber: 3 },
        recipient: { name: "Fixture buyer", vatZone: { vatZoneNumber: eu ? 2 : 1 } }, references: { other: invoice.number },
        lines: [{ lineNumber: 1, sortKey: 1, description: "Work", product: { productNumber: eu ? "EU-SERVICES" : "DK-SALES" }, quantity: 1, unitNetPrice: 100.1 }] } })
    expect(economicProvider.map(event, settings)).toEqual(economicProvider.map(event, settings))
    expect(JSON.stringify({ event, settings })).toBe(before)
  })
  it("maps a credit once with negative quantities and keeps the booking step separate", () => {
    const { invoice, settings } = fixture()
    const result = economicProvider.map({ deliveryId: "credit-delivery", type: "credit_note.issued", schemaVersion: 2, payload: creditFixture(invoice) }, settings)
    expect(result).toMatchObject({ status: "prepared", idempotencyKey: "credit-delivery", expectedTotals: { net: "-100.10", tax: "-25.03", gross: "-125.13" },
      payload: { dueDate: invoice.issueDate, lines: [{ quantity: -1, unitNetPrice: 100.1 }] } })
    expect(economicBookingPayload(77)).toEqual({ draftInvoice: { draftInvoiceNumber: 77 }, sendBy: "none" })
    expect(() => economicBookingPayload(0)).toThrow("Invalid draft number")
  })
  it.each(refusalFixtures)("preserves the ledger refusal for $name", ({ event, code }) => {
    expect(economicProvider.map({ ...event, deliveryId: "delivery-1" }, fixture().settings)).toMatchObject({ status: "refused", code })
  })
  it("refuses an absent VAT mapping and unsupported payment events", () => {
    const { event, settings } = fixture()
    expect(economicProvider.map(event, { ...settings, vatMappings: {} })).toMatchObject({ status: "refused", code: "missing_mapping" })
    expect(economicProvider.map({ ...event, type: "payment.recorded" }, settings)).toMatchObject({ status: "refused", code: "event_not_supported" })
  })
  it("preserves frozen line order and refuses multiple recipient VAT zones", () => {
    const { event, settings, invoice } = fixture()
    const multi = invoiceFixture({ lines: [0, 1].map(sortOrder => ({ quantity: "1", unitPrice: "100", sortOrder,
      vat: { ...invoice.lines[0]!.vat, country: sortOrder ? "SE" : "DK" } })) })
    multi.buyer.name = "Fixture buyer"
    multi.lines.forEach((line, i) => { line.description = `Work ${i}` })
    const mappings = { ...settings.vatMappings, [multi.vatGroups[1]!.key]: { productNumber: "SECOND", vatZoneNumber: 1 } }
    const input = { ...event, payload: multi }
    expect(economicProvider.map(input, { ...settings, vatMappings: mappings })).toMatchObject({ status: "prepared",
      expectedTotals: { net: "200.00", tax: "50.00", gross: "250.00" }, payload: { lines: [
        { lineNumber: 1, sortKey: 1, description: "Work 0", product: { productNumber: "DK-SALES" } },
        { lineNumber: 2, sortKey: 2, description: "Work 1", product: { productNumber: "SECOND" } },
      ] } })
    mappings[multi.vatGroups[1]!.key]!.vatZoneNumber = 2
    expect(economicProvider.map(input, { ...settings, vatMappings: mappings })).toMatchObject({ status: "refused", code: "unsupported_document" })
  })
  it("refuses currencies outside the initial DKK contract", () => {
    const { event, settings } = fixture()
    expect(economicProvider.map({ ...event, payload: invoiceFixture({ currency: "EUR" }) }, settings)).toMatchObject({ status: "refused", code: "unsupported_document" })
  })
  it("refuses money beyond the JSON minor-unit boundary", () => {
    const { settings, event, invoice } = fixture()
    const huge = invoiceFixture({ lines: [{ quantity: "1000000", unitPrice: "1000000000000", sortOrder: 0, vat: invoice.lines[0]!.vat }] })
    huge.buyer.name = "Fixture buyer"
    expect(economicProvider.map({ ...event, payload: huge }, settings)).toMatchObject({ status: "refused", code: "amount_not_representable" })
  })
  it("refuses allocated inclusive tax that cannot be reproduced from the frozen net", () => {
    const { settings, event, invoice } = fixture()
    const inclusive = invoiceFixture({ pricesIncludeTax: true, lines: [0, 1].map(sortOrder => ({ quantity: "1", unitPrice: "0.03", sortOrder, vat: invoice.lines[0]!.vat })) })
    inclusive.buyer.name = "Fixture buyer"
    expect(economicProvider.map({ ...event, payload: inclusive }, settings)).toMatchObject({ status: "refused", code: "unsupported_document" })
  })
})
