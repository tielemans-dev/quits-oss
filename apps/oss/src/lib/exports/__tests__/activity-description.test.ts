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

  it("names the payment details that changed, without showing their values", () => {
    const event = {
      type: "organization.payment_details_updated",
      aggregateType: "organization",
      payload: {
        changes: [
          { field: "iban", before: "****6243", after: "****1100" },
          { field: "regNumber", before: "0040", after: "5000" },
          { field: "note", before: null, after: "****" },
        ],
      },
    }
    expect(describeActivity(event, en)).toBe("Payment details changed: IBAN, Reg. no., Payment note")
    expect(describeActivity(event, da)).toBe("Betalingsoplysninger ændret: IBAN, Reg.nr., Betalingsnote")
    expect(describeActivity(event, en)).not.toContain("6243")
    expect(aggregateLabel("organization", en)).toBe("Organization")
    expect(aggregateLabel("organization", da)).toBe("Organisation")
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
