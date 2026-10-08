import { describe, expect, it } from "vitest"

import { ACTIVITY_KINDS, activityKind, activityLabelKey, activityTarget, describeActivity } from "../activity-events"
import { daCatalog } from "../../../lib/i18n/catalog/da"
import { enCatalog } from "../../../lib/i18n/catalog/en"

const event = (
  id: string,
  type: string,
  aggregateId: string,
  aggregateType = type.split(".")[0]!,
  occurredAt = "2026-10-07T10:00:00.000Z"
) => ({ id, sequence: Number(id.replace(/\D/g, "")) || 0, type, aggregateType, aggregateId, occurredAt })

describe("activity type mapping", () => {
  it("maps the types a person cares about", () => {
    expect(activityKind("invoice.sent")).toBe("invoiceSent")
    expect(activityKind("invoice.issued")).toBe("invoiceSent")
    expect(activityKind("payment.recorded")).toBe("paymentRecorded")
    expect(activityKind("invoice.paid")).toBe("invoicePaid")
    expect(activityKind("invoice.reminder_sent")).toBe("reminderSent")
    expect(activityKind("quote.accepted")).toBe("quoteAccepted")
    expect(activityKind("credit_note.issued")).toBe("creditNoteIssued")
    expect(activityKind("invoice.email_failed")).toBe("deliveryFailed")
    expect(activityKind("invoice.email_unconfirmed")).toBe("deliveryUnconfirmed")
  })

  it("leaves out types that mean nothing to a user, and unknown ones", () => {
    for (const type of [
      "invoice.draft_updated",
      "invoice.draft_deleted",
      "document.number_voided",
      "invoice.base_valuation_recorded",
      "document.artifact_stored",
      "invoice.reminders_paused",
      "invoice.reminder_skipped",
      "agreement.draft_created",
      "something.new",
    ]) {
      expect(activityKind(type)).toBeNull()
    }
  })

  it("has a singular and a plural label in both languages for every kind", () => {
    for (const kind of ACTIVITY_KINDS) {
      for (const count of [1, 2]) {
        const key = activityLabelKey(kind, count)
        expect(daCatalog[key as keyof typeof daCatalog], `da ${key}`).toBeTruthy()
        expect(enCatalog[key as keyof typeof enCatalog], `en ${key}`).toBeTruthy()
      }
    }
  })
})

describe("activity targets", () => {
  it("points at the document the event is about, and at nothing for a bare payment", () => {
    expect(activityTarget({ aggregateType: "invoice", aggregateId: "a" })).toEqual({ to: "invoice", id: "a" })
    expect(activityTarget({ aggregateType: "quote", aggregateId: "q" })).toEqual({ to: "quote", id: "q" })
    expect(activityTarget({ aggregateType: "credit_note", aggregateId: "c" })).toEqual({ to: "creditNote", id: "c" })
    expect(activityTarget({ aggregateType: "creditNote", aggregateId: "c" })).toEqual({ to: "creditNote", id: "c" })
    expect(activityTarget({ aggregateType: "agreement", aggregateId: "g" })).toEqual({ to: "agreement", id: "g" })
    expect(activityTarget({ aggregateType: "payment", aggregateId: "p" })).toEqual({ to: "none" })
  })
})

describe("describeActivity", () => {
  it("drops events without a label", () => {
    const lines = describeActivity([event("e2", "invoice.draft_updated", "a"), event("e1", "invoice.sent", "a")])
    expect(lines.map((line) => line.kind)).toEqual(["invoiceSent"])
  })

  it("merges neighbours of one kind and counts each document once", () => {
    const lines = describeActivity([
      event("e4", "invoice.sent", "a"),
      event("e3", "invoice.issued", "a"),
      event("e2", "invoice.sent", "b"),
      event("e1", "invoice.sent", "c"),
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ kind: "invoiceSent", count: 3, target: { to: "none" } })
  })

  it("keeps the link when a line is about one document", () => {
    const [line] = describeActivity([event("e2", "invoice.sent", "a"), event("e1", "invoice.issued", "a")])
    expect(line).toMatchObject({ count: 1, target: { to: "invoice", id: "a" } })
  })

  it("does not tell a payment twice when the same invoice is also reported paid", () => {
    const lines = describeActivity([event("e2", "invoice.paid", "a"), event("e1", "payment.recorded", "a")])
    expect(lines.map((line) => line.kind)).toEqual(["invoicePaid"])
    // A part payment has no paid event, so it stays.
    expect(describeActivity([event("e1", "payment.recorded", "a")]).map((line) => line.kind)).toEqual(["paymentRecorded"])
  })

  it("keeps newest first and does not merge across different kinds", () => {
    const lines = describeActivity([
      event("e3", "invoice.sent", "a"),
      event("e2", "invoice.reminder_sent", "b"),
      event("e1", "invoice.sent", "c"),
    ])
    expect(lines.map((line) => line.kind)).toEqual(["invoiceSent", "reminderSent", "invoiceSent"])
  })
})
