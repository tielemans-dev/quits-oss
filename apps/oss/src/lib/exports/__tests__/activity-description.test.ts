import { describe, expect, it } from "vitest"
import { translate } from "../../i18n/translate"
import { aggregateLabel, describeActivity, humanizeEventType } from "../activity-description"

const en = (key: Parameters<typeof translate>[0], vars?: Record<string, string | number>) =>
  translate(key, "en-US", vars)
const da = (key: Parameters<typeof translate>[0], vars?: Record<string, string | number>) =>
  translate(key, "da-DK", vars)

describe("activity descriptions", () => {
  it("describes known events with payload values", () => {
    const event = { type: "invoice.draft_created", aggregateType: "invoice", payload: { number: "INV-0001" } }
    expect(describeActivity(event, en)).toBe("Draft invoice INV-0001 created")
    expect(describeActivity(event, da)).toBe("Fakturakladde INV-0001 oprettet")
  })

  it("picks payload variants for sent invoices", () => {
    const sent = (payload: Record<string, unknown>) =>
      describeActivity({ type: "invoice.sent", aggregateType: "invoice", payload }, en)
    expect(sent({ number: "INV-1", emailSent: true, recipient: "a@b.test" })).toBe("Invoice INV-1 sent to a@b.test")
    expect(sent({ number: "INV-1", emailSent: false, recipient: null })).toBe("Invoice INV-1 issued without email")
    expect(sent({ number: "INV-1" })).toBe("Invoice INV-1 sent")
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
