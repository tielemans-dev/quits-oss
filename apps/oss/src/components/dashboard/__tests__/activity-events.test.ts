import { DASHBOARD_ACTIVITY_EVENT_TYPES } from "@quits/contracts/dashboard"
import { describe, expect, it } from "vitest"

import { ACTIVITY_KINDS, activityKind, activityLabelKey, activityTarget, describeActivity } from "../activity-events"
import { daCatalog } from "../../../lib/i18n/catalog/da"
import { enCatalog } from "../../../lib/i18n/catalog/en"
import { activityEvent } from "./fixtures"

describe("activity type mapping", () => {
  it("labels every type the server allows, in both languages, with and without a number", () => {
    for (const type of DASHBOARD_ACTIVITY_EVENT_TYPES) {
      const kind = activityKind(type)
      expect(kind, type).not.toBeNull()
      for (const numbered of [false, true]) {
        const key = activityLabelKey(kind!, numbered)
        expect(daCatalog[key as keyof typeof daCatalog], `da ${type} ${key}`).toBeTruthy()
        expect(enCatalog[key as keyof typeof enCatalog], `en ${type} ${key}`).toBeTruthy()
      }
    }
  })

  it("has no kind without an allowlisted type, so no label goes unused", () => {
    const used = new Set(DASHBOARD_ACTIVITY_EVENT_TYPES.map((type) => activityKind(type)))
    expect([...ACTIVITY_KINDS].filter((kind) => !used.has(kind))).toEqual([])
  })

  it("maps the types a person cares about", () => {
    expect(activityKind("invoice.sent")).toBe("invoiceSent")
    expect(activityKind("invoice.issued")).toBe("invoiceSent")
    expect(activityKind("payment.recorded")).toBe("paymentRecorded")
    expect(activityKind("invoice.paid")).toBe("invoicePaid")
    expect(activityKind("invoice.email_failed")).toBe("deliveryFailed")
    expect(activityKind("agreement.email_failed")).toBe("deliveryFailed")
    expect(activityKind("agreement.email_unconfirmed")).toBe("deliveryUnconfirmed")
  })

  it("has no label for a type outside the allowlist, such as one from a newer server", () => {
    for (const type of ["invoice.draft_updated", "document.number_voided", "something.new"]) {
      expect(activityKind(type)).toBeNull()
    }
  })
})

describe("activity targets", () => {
  it("points at the document by the server's documentKind", () => {
    expect(activityTarget({ documentKind: "invoice", aggregateId: "a" })).toEqual({ to: "invoice", id: "a" })
    expect(activityTarget({ documentKind: "quote", aggregateId: "q" })).toEqual({ to: "quote", id: "q" })
    expect(activityTarget({ documentKind: "credit_note", aggregateId: "c" })).toEqual({ to: "creditNote", id: "c" })
    expect(activityTarget({ documentKind: "agreement", aggregateId: "g" })).toEqual({ to: "agreement", id: "g" })
    expect(activityTarget({ documentKind: null, aggregateId: "p" })).toEqual({ to: "none" })
  })
})

describe("describeActivity", () => {
  it("carries the number and the customer, and links to the document", () => {
    const [line] = describeActivity([
      activityEvent({ id: "e1", type: "invoice.sent", aggregateId: "a", documentNumber: "2026-148", customerName: "Nordlys Studio" }),
    ])
    expect(line).toMatchObject({
      kind: "invoiceSent",
      number: "2026-148",
      customerName: "Nordlys Studio",
      target: { to: "invoice", id: "a" },
    })
  })

  it("does not tell a payment twice when the same invoice is also reported paid", () => {
    const lines = describeActivity([
      activityEvent({ id: "e2", type: "invoice.paid", aggregateId: "a" }),
      activityEvent({ id: "e1", type: "payment.recorded", aggregateId: "a" }),
    ])
    expect(lines.map((line) => line.kind)).toEqual(["invoicePaid"])
    // A part payment has no paid event, so it stays.
    expect(describeActivity([activityEvent({ id: "e1", type: "payment.recorded", aggregateId: "a" })]).map((line) => line.kind)).toEqual(["paymentRecorded"])
  })

  it("collapses a repeat of one kind for one document, and keeps different documents apart", () => {
    const lines = describeActivity([
      activityEvent({ id: "e4", type: "invoice.sent", aggregateId: "a", documentNumber: "1" }),
      activityEvent({ id: "e3", type: "invoice.issued", aggregateId: "a", documentNumber: "1" }),
      activityEvent({ id: "e2", type: "invoice.sent", aggregateId: "b", documentNumber: "2" }),
    ])
    expect(lines.map((line) => line.number)).toEqual(["1", "2"])
  })

  it("keeps newest first across kinds", () => {
    const lines = describeActivity([
      activityEvent({ id: "e3", type: "invoice.sent", aggregateId: "a" }),
      activityEvent({ id: "e2", type: "invoice.reminder_sent", aggregateId: "b" }),
      activityEvent({ id: "e1", type: "invoice.sent", aggregateId: "c" }),
    ])
    expect(lines.map((line) => line.kind)).toEqual(["invoiceSent", "reminderSent", "invoiceSent"])
  })
})
