import { describe, expect, it } from "vitest"
import { translate } from "../../i18n/translate"
import { eventRegistry } from "../../../domain/events/registry"
import { daMessages, enMessages } from "../../i18n/messages"
import { activityMessageKey, aggregateLabel, describeActivity, humanizeEventType } from "../activity-description"

const en = (key: Parameters<typeof translate>[0], vars?: Record<string, string | number>) =>
  translate(key, "en-US", vars)
const da = (key: Parameters<typeof translate>[0], vars?: Record<string, string | number>) =>
  translate(key, "da-DK", vars)

describe("activity descriptions", () => {
  it.each(["disconnect", "retry", "skip"])("localizes accounting %s in the audit log", action => {
    const event = { type: "accounting.action_recorded", aggregateType: "organization", payload: { action, provider: "dinero", deliveryId: "delivery-1", reason: "Entered manually" } }
    expect(describeActivity(event, en)).not.toBe("Activity recorded")
    expect(describeActivity(event, da)).not.toBe(describeActivity(event, en))
    if (action === "skip") expect(describeActivity(event, en)).toContain("Entered manually")
  })
  it.each([
    ["invoice.issued", "Faktura INV-0001 udstedt", "Invoice INV-0001 issued"],
    ["invoice.credited", "Faktura INV-0001 krediteret med kreditnota CN-0001", "Invoice INV-0001 credited with credit note CN-0001"],
    ["quote.accepted", "Tilbud INV-0001 accepteret", "Quote INV-0001 accepted"],
    ["invoice.became_overdue", "Faktura INV-0001 er forfaldet", "Invoice INV-0001 is overdue"],
    ["credit_note.issued", "Kreditnota INV-0001 udstedt", "Credit note INV-0001 issued"],
  ])("localizes %s with payload values", (type, danish, english) => {
    const event = { type, aggregateType: "document", payload: { number: "INV-0001", creditNoteNumber: "CN-0001", invoiceNumber: "INV-0002" } }
    expect(describeActivity(event, da)).toBe(danish)
    expect(describeActivity(event, en)).toBe(english)
  })

  it("covers every registered quote and credit event in both catalogs without unresolved placeholders", () => {
    for (const type of Object.keys(eventRegistry).filter(type => /^(quote|credit_note)\./.test(type))) {
      const event = { type, aggregateType: "document", payload: {} }
      expect(activityMessageKey(event), type).not.toBeNull()
      expect(describeActivity(event, da), type).not.toMatch(/[{}]/)
      expect(describeActivity(event, en), type).not.toMatch(/[{}]/)
      expect(describeActivity(event, da)).not.toBe(describeActivity(event, en))
    }
  })
  it("localizes invoice issuance with its document number", () => {
    const event = { type: "invoice.issued", aggregateType: "invoice", payload: { number: "INV-0002" } }
    expect(describeActivity(event, da)).toBe("Faktura INV-0002 udstedt")
    expect(describeActivity(event, en)).toBe("Invoice INV-0002 issued")
  })

  it.each(Object.keys(eventRegistry).filter(type => type !== "settlement.changed"))("has da/en copy for registered event %s", type => {
    const key = activityMessageKey({ type, aggregateType: "invoice", payload: {} })
    expect(key).not.toBeNull()
    expect(daMessages[key!]).toBeTruthy()
    expect(enMessages[key!]).toBeTruthy()
    expect(describeActivity({ type, aggregateType: "invoice", payload: {} }, da)).not.toMatch(/\{\w+\}/)
  })

  it.each(["refund", "customer_credit", "reverse_allocation", "reverse_refund", "reverse_receipt"])("localizes settlement action %s", action => {
    const key = activityMessageKey({ type: "settlement.changed", aggregateType: "settlementReceipt", payload: { action } })
    expect(key).not.toBeNull()
    expect(daMessages[key!]).toBeTruthy()
    expect(enMessages[key!]).toBeTruthy()
  })

  it.each([
    ["a draft invoice without a number", { number: "Q-0001", invoiceId: "inv_1", invoiceNumber: null }, "Tilbud Q-0001 omdannet til fakturakladde", "Quote Q-0001 converted to a draft invoice"],
    ["a numbered invoice", { number: "Q-0001", invoiceId: "inv_1", invoiceNumber: "INV-0002" }, "Tilbud Q-0001 omdannet til faktura INV-0002", "Quote Q-0001 converted to invoice INV-0002"],
  ])("describes a converted quote with %s", (_name, payload, danish, english) => {
    const event = { type: "quote.converted", aggregateType: "quote", payload }
    expect(describeActivity(event, da)).toBe(danish)
    expect(describeActivity(event, en)).toBe(english)
  })

  it("describes a settlement change without a known action with the generic fallback", () => {
    const event = { type: "settlement.changed", aggregateType: "settlementReceipt", payload: {} }
    expect(describeActivity(event, da)).toBe("Kundeindbetaling justeret (refusion, kundetilgodehavende eller tilbageførsel)")
    expect(describeActivity(event, en)).toBe("Customer payment adjusted (refund, customer credit or reversal)")
  })

  it("does not invent an English description for an unknown event", () => {
    const event = { type: "widget.updated", aggregateType: "widget", payload: {} }
    expect(describeActivity(event, da)).toBe("Aktivitet registreret")
    expect(describeActivity(event, en)).toBe("Activity recorded")
  })

  it("describes known events with payload values", () => {
    const event = { type: "invoice.draft_created", aggregateType: "invoice", payload: { number: "INV-0001" } }
    expect(describeActivity(event, en)).toBe("Draft invoice INV-0001 created")
    expect(describeActivity(event, da)).toBe("Fakturakladde INV-0001 oprettet")
  })

  it.each([
    ["payment.voided", "Betaling annulleret", "Payment voided"],
    ["payment.recorded", "Betaling registreret", "Payment recorded"],
    ["invoice.paid", "Faktura betalt", "Invoice paid"],
  ])("localizes %s in Danish and English", (type, danish, english) => {
    const event = { type, aggregateType: "invoice", payload: {} }
    expect(describeActivity(event, da)).toBe(danish)
    expect(describeActivity(event, en)).toBe(english)
  })

  it("picks payload variants for sent invoices", () => {
    const sent = (payload: Record<string, unknown>) =>
      describeActivity({ type: "invoice.sent", aggregateType: "invoice", payload }, en)
    expect(sent({ number: "INV-1", emailSent: true, recipient: "a@b.test" })).toBe("Invoice INV-1 sent to a@b.test")
    expect(sent({ number: "INV-1", emailSent: false, recipient: null })).toBe("Invoice INV-1 issued without email")
    expect(sent({ number: "INV-1" })).toBe("Invoice INV-1 sent")
  })

  it("names the payment details that changed, without showing their values", () => {
    const event = {
      type: "organization.payment_details_updated",
      aggregateType: "organization",
      payload: {
        changedBy: { kind: "user", id: "user-1", name: "Mette Admin", email: "mette@example.com" },
        changes: [
          { field: "iban", before: "DK****6243", after: "DK****1100" },
          { field: "regNumber", before: "0040", after: "5000" },
          { field: "note", before: null, after: "****" },
        ],
      },
    }
    expect(describeActivity(event, en)).toBe("Payment details changed by Mette Admin <mette@example.com>: IBAN, Reg. no., Payment note")
    expect(describeActivity(event, da)).toBe("Betalingsoplysninger ændret af Mette Admin <mette@example.com>: IBAN, Reg.nr., Bemærkning til betaling")
    expect(describeActivity(event, en)).not.toContain("6243")
    expect(aggregateLabel("organization", en)).toBe("Organization")
    expect(aggregateLabel("organization", da)).toBe("Organisation")
  })

  it("explains the gap a deleted draft leaves, and any other voided number", () => {
    const voided = (reason: string) => ({ type: "document.number_voided", aggregateType: "document", payload: { number: "INV-0007", documentKind: "invoice", reason } })
    expect(describeActivity(voided("draft_deleted"), en)).toBe("Number INV-0007 left unused: its draft was deleted")
    expect(describeActivity(voided("draft_deleted"), da)).toBe("Nummer INV-0007 er ubrugt: kladden blev slettet")
    expect(describeActivity(voided("reservation_expired"), en)).toBe("Number INV-0007 was not used")
    expect(aggregateLabel("document", da)).toBe("Dokument")
  })

  it("tolerates missing payload values and unknown event types", () => {
    expect(describeActivity({ type: "invoice.sent", aggregateType: "invoice", payload: {} }, en)).toBe("Invoice sent")
    expect(describeActivity({ type: "payment.recorded", aggregateType: "payment", payload: {} }, en)).toBe(
      "Payment recorded"
    )
    expect(humanizeEventType("creditNote.issued")).toBe("Credit note issued")
  })

  it("labels aggregates in either spelling", () => {
    expect(aggregateLabel("credit_note", en)).toBe("Credit note")
    expect(aggregateLabel("agentKey", da)).toBe("Agentnøgle")
    expect(aggregateLabel("widget", en)).toBe("Widget")
  })
})
