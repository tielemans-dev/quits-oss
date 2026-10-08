import { describe, expect, it } from "vitest"
import {
  applyEinvoiceDeliveryEvent,
  EinvoiceDeliveryTransitionError,
  einvoiceDeliveryStateSchema,
  einvoiceRecipientResolutionSchema,
  initialEinvoiceDeliveryState,
  nextEinvoiceDeliveryAction,
  type EinvoiceDeliveryEvent,
  type EinvoiceDeliveryState,
} from "./einvoice-delivery"

const recipient = { scheme: "0088" as const, id: "5798009811639" }
const at = (minute: number) => `2026-10-08T10:${String(minute).padStart(2, "0")}:00.000Z`

function run(...events: EinvoiceDeliveryEvent[]): EinvoiceDeliveryState {
  return events.reduce(applyEinvoiceDeliveryEvent, initialEinvoiceDeliveryState("peppol_bis_billing_3", recipient))
}

const validated = { type: "validation_passed" } as const
const submitted = { type: "submitted", providerReference: "ref-1" } as const

describe("e-invoice delivery lifecycle", () => {
  it("keeps validation, transport and receiver response apart", () => {
    const state = run(validated, submitted, { type: "transport_delivered", at: at(1) })
    expect(state).toMatchObject({ validation: "passed", transport: "delivered", deliveredAt: at(1), receiverResponse: null })
    expect(nextEinvoiceDeliveryAction(state)).toBe("wait")
    expect(einvoiceDeliveryStateSchema.parse(state)).toEqual(state)
  })

  it("does not treat transport delivery as acceptance", () => {
    const accepted = run(validated, submitted, { type: "transport_delivered", at: at(1) },
      { type: "receiver_response", response: { kind: "invoice_response", code: "AP", at: at(2), note: null } })
    expect(accepted.receiverResponse).toMatchObject({ code: "AP" })
    expect(nextEinvoiceDeliveryAction(accepted)).toBe("wait")
    const paid = applyEinvoiceDeliveryEvent(accepted, { type: "receiver_response", response: { kind: "invoice_response", code: "PD", at: at(3), note: null } })
    expect(nextEinvoiceDeliveryAction(paid)).toBe("none")
  })

  it("refuses to submit a document that has not passed validation", () => {
    expect(() => run(submitted)).toThrow(EinvoiceDeliveryTransitionError)
    const failed = run({ type: "validation_failed", rules: ["DK-R-002"] })
    expect(failed.validationErrors).toEqual(["DK-R-002"])
    expect(nextEinvoiceDeliveryAction(failed)).toBe("credit_and_reissue")
    expect(() => applyEinvoiceDeliveryEvent(failed, submitted)).toThrow(/validated/)
  })

  it("reconciles an uncertain submission instead of sending it again", () => {
    const unknown = run(validated, { type: "submission_outcome_unknown" })
    expect(nextEinvoiceDeliveryAction(unknown)).toBe("reconcile")
    expect(() => applyEinvoiceDeliveryEvent(unknown, { type: "submitted", providerReference: "ref-2" })).toThrow(/already submitted/)
    const reconciled = applyEinvoiceDeliveryEvent(unknown, { type: "transport_delivered", at: at(4) })
    expect(reconciled.transport).toBe("delivered")
  })

  it("allows a resend only after a retryable failure", () => {
    const retryable = run(validated, submitted, { type: "transport_failed", code: "temporary-upstream-error", retryable: true })
    expect(nextEinvoiceDeliveryAction(retryable)).toBe("resubmit")
    expect(applyEinvoiceDeliveryEvent(retryable, { type: "submitted", providerReference: "ref-2" })).toMatchObject({ transport: "queued", providerReference: "ref-2" })

    const permanent = run(validated, submitted, { type: "transport_failed", code: "document-not-valid", retryable: false })
    expect(nextEinvoiceDeliveryAction(permanent)).toBe("investigate")
    expect(() => applyEinvoiceDeliveryEvent(permanent, { type: "submitted", providerReference: "ref-2" })).toThrow(EinvoiceDeliveryTransitionError)
  })

  it("treats a duplicate submission callback as a no-op", () => {
    const once = run(validated, submitted)
    expect(applyEinvoiceDeliveryEvent(once, submitted)).toBe(once)
  })

  it("asks for a recipient fix when the network has no route", () => {
    const state = run(validated, submitted, { type: "transport_no_route", code: "unable-to-deliver" })
    expect(nextEinvoiceDeliveryAction(state)).toBe("fix_recipient")
    expect(() => applyEinvoiceDeliveryEvent(state, { type: "transport_delivered", at: at(5) })).toThrow(/route/)
  })

  it("never lets a late transport failure undo a delivery", () => {
    const delivered = run(validated, submitted, { type: "transport_delivered", at: at(1) })
    expect(() => applyEinvoiceDeliveryEvent(delivered, { type: "transport_failed", code: "late", retryable: true })).toThrow(/delivered/)
    expect(applyEinvoiceDeliveryEvent(delivered, { type: "transport_delivered", at: at(9) })).toBe(delivered)
  })

  it("infers delivery from a receiver response that arrives before the receipt", () => {
    const state = run(validated, submitted, { type: "receiver_response", response: { kind: "invoice_response", code: "AB", at: at(2), note: null } })
    expect(state).toMatchObject({ transport: "delivered", deliveredAt: at(2) })
  })

  it("ignores an older receiver response and settles on a rejection", () => {
    const query = run(validated, submitted, { type: "transport_delivered", at: at(1) },
      { type: "receiver_response", response: { kind: "invoice_response", code: "UQ", at: at(5), note: "Missing order number" } })
    const stale = applyEinvoiceDeliveryEvent(query, { type: "receiver_response", response: { kind: "invoice_response", code: "AB", at: at(3), note: null } })
    expect(stale.receiverResponse).toMatchObject({ code: "UQ" })

    const rejected = applyEinvoiceDeliveryEvent(query, { type: "receiver_response", response: { kind: "invoice_response", code: "RE", at: at(6), note: null } })
    expect(nextEinvoiceDeliveryAction(rejected)).toBe("credit_and_reissue")
    expect(() => applyEinvoiceDeliveryEvent(rejected, { type: "receiver_response", response: { kind: "invoice_response", code: "AP", at: at(7), note: null } }))
      .toThrow(/final response/)
  })

  it("routes a message-level rejection to a credit note and reissue", () => {
    const state = run(validated, submitted, { type: "transport_delivered", at: at(1) },
      { type: "receiver_response", response: { kind: "message_rejected", at: at(2), reasons: ["BR-CO-15"] } })
    expect(nextEinvoiceDeliveryAction(state)).toBe("credit_and_reissue")
  })

  it("does not reopen validation after submission", () => {
    expect(() => applyEinvoiceDeliveryEvent(run(validated, submitted), validated)).toThrow(/after submission/)
  })

  it("accepts only Peppol EAS schemes in recipient resolutions", () => {
    expect(einvoiceRecipientResolutionSchema.safeParse({
      status: "unsupported_document", participant: { scheme: "0184", id: "29403473" }, checkedAt: at(0),
      advertised: ["Procurement-BilSim-1.0"],
    }).success).toBe(true)
    expect(einvoiceRecipientResolutionSchema.safeParse({
      status: "reachable", participant: { scheme: "DK:CVR", id: "29403473" }, checkedAt: at(0),
    }).success).toBe(false)
  })
})
