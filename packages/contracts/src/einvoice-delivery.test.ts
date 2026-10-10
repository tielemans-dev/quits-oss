import { describe, expect, it } from "vitest"
import {
  applyEinvoiceDeliveryEvent,
  EinvoiceDeliveryTransitionError,
  einvoiceDeliveryStateSchema,
  einvoiceDeliveryEventSchema,
  einvoiceParticipantSchema,
  einvoiceRecipientResolutionSchema,
  initialEinvoiceDeliveryState,
  nextEinvoiceDeliveryAction,
  nextEinvoiceRecipientAction,
  type EinvoiceDeliveryEvent,
  type EinvoiceDeliveryState,
} from "./einvoice-delivery"

const recipient = { scheme: "0088" as const, id: "5798009811639" }
const at = (minute: number) => `2026-10-08T10:${String(minute).padStart(2, "0")}:00.000Z`

function run(...events: EinvoiceDeliveryEvent[]): EinvoiceDeliveryState {
  return events.reduce(applyEinvoiceDeliveryEvent, initialEinvoiceDeliveryState("peppol_bis_billing_3", recipient, "invoice"))
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
    expect(nextEinvoiceDeliveryAction(failed)).toBe("review_correction")
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
    expect(applyEinvoiceDeliveryEvent(retryable, { type: "retry_submitted", providerReference: "ref-2" })).toMatchObject({ transport: "queued", providerReference: "ref-2" })

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
    expect(nextEinvoiceDeliveryAction(rejected)).toBe("review_correction")
    expect(() => applyEinvoiceDeliveryEvent(rejected, { type: "receiver_response", response: { kind: "invoice_response", code: "AP", at: at(7), note: null } }))
      .toThrow(/final response/)
  })

  it("routes a message-level rejection to correction review", () => {
    const state = run(validated, submitted, { type: "transport_delivered", at: at(1) },
      { type: "receiver_response", response: { kind: "message_rejected", at: at(2), reasons: ["BR-CO-15"] } })
    expect(nextEinvoiceDeliveryAction(state)).toBe("review_correction")
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

describe("participant scheme validation regressions", () => {
  const unknownSchemes = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", " constructor ", "9999", "DK:CVR"]

  it.each(unknownSchemes)("rejects participant scheme %s with a validation issue", (scheme) => {
    const result = einvoiceParticipantSchema.safeParse({ scheme, id: "x" })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({ code: "custom", path: ["scheme"], message: "Unknown Peppol EAS code" }),
      ])
    }
  })

  it.each(unknownSchemes)("rejects scheme %s in every recipient resolution", (scheme) => {
    for (const status of ["reachable", "not_registered", "unsupported_document", "lookup_failed"] as const) {
      const result = einvoiceRecipientResolutionSchema.safeParse({
        status, participant: { scheme, id: "x" }, checkedAt: at(0),
        ...(status === "unsupported_document" ? { advertised: [] } : {}),
        ...(status === "lookup_failed" ? { retryable: true } : {}),
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["participant", "scheme"] }))
      }
    }
  })

  it.each(unknownSchemes)("rejects scheme %s in delivery state for both document kinds", (scheme) => {
    for (const documentKind of ["invoice", "creditNote"] as const) {
      const initial = initialEinvoiceDeliveryState("peppol_bis_billing_3", recipient, documentKind)
      const result = einvoiceDeliveryStateSchema.safeParse({ ...initial, recipient: { scheme, id: "x" } })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["recipient", "scheme"] }))
      }
    }
  })

  it.each([
    { scheme: "0184", id: "29403473" },
    recipient,
    { scheme: "0130", id: "known-scheme-without-specific-format" },
  ] as const)("accepts a valid participant with known scheme $scheme", (participant) => {
    expect(einvoiceParticipantSchema.parse(participant)).toEqual(participant)
    expect(einvoiceRecipientResolutionSchema.safeParse({ status: "reachable", participant, checkedAt: at(0) }).success).toBe(true)
    for (const documentKind of ["invoice", "creditNote"] as const) {
      const initial = initialEinvoiceDeliveryState("peppol_bis_billing_3", participant, documentKind)
      expect(einvoiceDeliveryStateSchema.parse(initial)).toEqual(initial)
    }
  })
})

describe("Denmark discovery review regressions", () => {
  it.each(["invoice", "creditNote"] as const)("reconciles a timed-out safe retry for %s against its own reference", (documentKind) => {
    const initial = initialEinvoiceDeliveryState("peppol_bis_billing_3", recipient, documentKind)
    const failed = [validated, submitted, { type: "transport_failed", code: "not_delivered", retryable: true } as const]
      .reduce(applyEinvoiceDeliveryEvent, initial)
    const timeout = { type: "retry_outcome_unknown", previousProviderReference: "ref-1" } as const
    expect(einvoiceDeliveryEventSchema.parse(timeout)).toEqual(timeout)
    const unknown = applyEinvoiceDeliveryEvent(failed, timeout)
    expect(unknown).toMatchObject({ transport: "unknown", providerReference: null, transportCode: null, transportRetryable: false })
    expect(nextEinvoiceDeliveryAction(unknown)).toBe("reconcile")
    expect(einvoiceDeliveryStateSchema.parse(unknown)).toEqual(unknown)
    for (const providerReference of ["ref-1", "ref-2"]) {
      const reconciled = applyEinvoiceDeliveryEvent(unknown, { type: "submission_reconciled", providerReference })
      expect(reconciled).toMatchObject({ transport: "queued", providerReference })
      expect(einvoiceDeliveryStateSchema.parse(reconciled)).toEqual(reconciled)
      expect(() => applyEinvoiceDeliveryEvent(unknown, { type: "retry_submitted", providerReference })).toThrow(EinvoiceDeliveryTransitionError)
    }
    expect(() => applyEinvoiceDeliveryEvent(failed, { ...timeout, previousProviderReference: "another-attempt" }))
      .toThrow(EinvoiceDeliveryTransitionError)
    // An ordinary late timeout is about the original submission, not evidence of a new retry.
    const originalUnknown = applyEinvoiceDeliveryEvent(failed, { type: "submission_outcome_unknown" })
    expect(originalUnknown.providerReference).toBe("ref-1")
    expect(() => applyEinvoiceDeliveryEvent(originalUnknown, { type: "submission_reconciled", providerReference: "ref-2" }))
      .toThrow(EinvoiceDeliveryTransitionError)
    for (const state of [initial, applyEinvoiceDeliveryEvent(initial, validated), run(validated, submitted), unknown,
      run(validated, submitted, { type: "transport_failed", code: "permanent", retryable: false }),
      run(validated, submitted, { type: "transport_no_route", code: "no_route" }),
      run(validated, submitted, { type: "transport_delivered", at: at(1) })]) {
      expect(() => applyEinvoiceDeliveryEvent(state, timeout)).toThrow(EinvoiceDeliveryTransitionError)
    }
  })

  it("rejects malformed participant identifiers before route evidence is accepted", () => {
    for (const participant of [{ scheme: "0184", id: "1234" }, { scheme: "0088", id: "5798009811638" },
      { scheme: "0184", id: "2940 3473" }, { scheme: "0184", id: "x".repeat(81) }]) {
      expect(einvoiceParticipantSchema.safeParse(participant).success).toBe(false)
      expect(einvoiceRecipientResolutionSchema.safeParse({ status: "reachable", participant, checkedAt: at(0) }).success).toBe(false)
    }
    expect(einvoiceParticipantSchema.parse({ scheme: "0184", id: "29403473" })).toEqual({ scheme: "0184", id: "29403473" })
    expect(einvoiceParticipantSchema.parse(recipient)).toEqual(recipient)
  })

  it("rejects contradictory parsed delivery state", () => {
    const queued = run(validated, submitted)
    for (const change of [
      { validation: "not_run" }, { validation: "failed", validationErrors: [] }, { validationErrors: ["unexpected"] },
      { providerReference: null }, { transportRetryable: true }, { deliveredAt: at(1) }, { transportCode: "stale" },
      { receiverResponse: { kind: "invoice_response", code: "AB", at: at(1), note: null } },
      { transport: "delivered", deliveredAt: null }, { transport: "no_route", transportCode: null },
      { transport: "failed", transportCode: null }, { transport: "not_sent" },
    ] satisfies Partial<EinvoiceDeliveryState>[]) {
      expect(einvoiceDeliveryStateSchema.safeParse({ ...queued, ...change }).success).toBe(false)
    }
    for (const state of [initialEinvoiceDeliveryState("peppol_bis_billing_3", recipient, "invoice"),
      run({ type: "validation_failed", rules: ["DK-R-002"] }), queued,
      run(validated, { type: "submission_outcome_unknown" }),
      run(validated, submitted, { type: "transport_failed", code: "permanent", retryable: false }),
      run(validated, submitted, { type: "transport_no_route", code: "no_route" }),
      run(validated, { type: "submission_outcome_unknown" }, { type: "transport_delivered", at: at(1) }),
      run(validated, submitted, { type: "receiver_response", response: { kind: "invoice_response", code: "AB", at: at(1), note: null } })]) {
      expect(einvoiceDeliveryStateSchema.parse(state)).toEqual(state)
    }
  })

  it("refuses transport and receiver evidence before any submission", () => {
    for (const state of [initialEinvoiceDeliveryState("peppol_bis_billing_3", recipient, "invoice"), run(validated)]) {
      for (const event of [{ type: "transport_delivered", at: at(1) }, { type: "transport_no_route", code: "no_route" },
        { type: "transport_failed", code: "failure", retryable: true },
        { type: "receiver_response", response: { kind: "invoice_response", code: "AB", at: at(1), note: null } }] satisfies EinvoiceDeliveryEvent[]) {
        expect(() => applyEinvoiceDeliveryEvent(state, event)).toThrow(EinvoiceDeliveryTransitionError)
      }
    }
  })

  it.each(["invoice", "creditNote"] as const)("keeps terminal failures settled through late evidence for %s", (documentKind) => {
    const start = initialEinvoiceDeliveryState("peppol_bis_billing_3", recipient, documentKind)
    const queued = [validated, submitted].reduce(applyEinvoiceDeliveryEvent, start)
    const terminalEvents = [
      { type: "transport_no_route", code: "no_action_taken" },
      { type: "transport_failed", code: "failed", retryable: false },
    ] as const
    for (const event of terminalEvents) {
      const settled = applyEinvoiceDeliveryEvent(queued, event)
      const lateUnknown = applyEinvoiceDeliveryEvent(settled, { type: "submission_outcome_unknown" })
      expect(lateUnknown).toBe(settled)
      expect(() => applyEinvoiceDeliveryEvent(lateUnknown, { type: "submission_reconciled", providerReference: "ref-1" }))
        .toThrow(EinvoiceDeliveryTransitionError)
      for (const conflictingEvent of [
        { type: "transport_failed", code: "temporary-upstream-error", retryable: true },
        { type: "transport_failed", code: "different-permanent-failure", retryable: false },
        { type: "transport_no_route", code: "different-route-failure" },
        { type: "transport_delivered", at: at(3) },
        { type: "receiver_response", response: { kind: "invoice_response", code: "AB", at: at(3), note: null } },
      ] satisfies EinvoiceDeliveryEvent[]) {
        expect(() => applyEinvoiceDeliveryEvent(settled, conflictingEvent)).toThrow(EinvoiceDeliveryTransitionError)
      }
      expect(applyEinvoiceDeliveryEvent(settled, event)).toBe(settled)
      expect(() => applyEinvoiceDeliveryEvent(settled, { type: "retry_submitted", providerReference: "ref-2" }))
        .toThrow(EinvoiceDeliveryTransitionError)
      expect(nextEinvoiceDeliveryAction(settled)).toBe(event.type === "transport_no_route" ? "fix_recipient" : "investigate")
    }
  })

  it.each([false, true])("reconciles queued status without sending again, known reference: %s", (known) => {
    const state = run(validated, ...(known ? [submitted] : []), { type: "submission_outcome_unknown" })
    const event = einvoiceDeliveryEventSchema.parse({ type: "submission_reconciled", providerReference: "ref-1" })
    const queued = applyEinvoiceDeliveryEvent(state, event)
    expect(queued).toMatchObject({ transport: "queued", providerReference: "ref-1", transportRetryable: false, transportCode: null })
    expect(nextEinvoiceDeliveryAction(queued)).toBe("wait")
    expect(applyEinvoiceDeliveryEvent(queued, event)).toBe(queued)
    // A submit acknowledgment is not evidence from a reconciliation lookup.
    expect(() => applyEinvoiceDeliveryEvent(state, submitted)).toThrow(EinvoiceDeliveryTransitionError)
    expect(() => applyEinvoiceDeliveryEvent(state, { type: "retry_submitted", providerReference: "ref-1" })).toThrow(EinvoiceDeliveryTransitionError)
  })

  it("refuses reconciliation for a different submission or before a send", () => {
    const known = run(validated, submitted, { type: "submission_outcome_unknown" })
    expect(() => applyEinvoiceDeliveryEvent(known, { type: "submission_reconciled", providerReference: "ref-2" })).toThrow(/reference/)
    expect(() => applyEinvoiceDeliveryEvent(run(validated), { type: "submission_reconciled", providerReference: "ref-1" })).toThrow(EinvoiceDeliveryTransitionError)
  })

  it.each(["ref-1", "ref-2"])("acknowledges an explicitly permitted retry with %s", (providerReference) => {
    const failed = run(validated, submitted, { type: "transport_failed", code: "temporary-upstream-error", retryable: true })
    const event = einvoiceDeliveryEventSchema.parse({ type: "retry_submitted", providerReference })
    const queued = applyEinvoiceDeliveryEvent(failed, event)
    expect(queued).toMatchObject({ transport: "queued", providerReference, transportCode: null, transportRetryable: false })
    expect(nextEinvoiceDeliveryAction(queued)).toBe("wait")
    expect(applyEinvoiceDeliveryEvent(queued, event)).toBe(queued)
    // An old acknowledgment cannot masquerade as a new retry acknowledgment.
    expect(applyEinvoiceDeliveryEvent(failed, submitted)).toBe(failed)
  })

  it.each(["no_route", "permanent_failure", "delivered"])("does not reopen %s with a queued reconciliation or retry", (outcome) => {
    const settled = run(validated, submitted, outcome === "no_route"
      ? { type: "transport_no_route", code: "no_action_taken" }
      : outcome === "delivered" ? { type: "transport_delivered", at: at(1) }
        : { type: "transport_failed", code: "failed", retryable: false })
    for (const type of ["submission_reconciled", "retry_submitted"] as const) {
      expect(() => applyEinvoiceDeliveryEvent(settled, { type, providerReference: "ref-1" })).toThrow(EinvoiceDeliveryTransitionError)
    }
  })

  it("keeps a duplicate-key HTTP 422 uncertain until evidence identifies the first submission", () => {
    // Proposed Storecove mapping, not an HTTP adapter or a sandbox exchange.
    // Only a confirmed duplicate-idempotencyGuid 422 has this meaning, not every 422.
    const duplicate = run(validated, { type: "submission_outcome_unknown" }, { type: "submission_outcome_unknown" })
    expect(duplicate.providerReference).toBeNull()
    expect(nextEinvoiceDeliveryAction(duplicate)).toBe("reconcile")
    expect(() => applyEinvoiceDeliveryEvent(duplicate, submitted)).toThrow(EinvoiceDeliveryTransitionError)
    const reconciled = applyEinvoiceDeliveryEvent(duplicate, { type: "submission_reconciled", providerReference: "first-submission" })
    expect(reconciled.transport).toBe("queued")
  })

  it.each(["invoice", "creditNote"] as const)("requires human correction review for %s without a financial command", (documentKind) => {
    const start = initialEinvoiceDeliveryState("peppol_bis_billing_3", recipient, documentKind)
    const invalid = applyEinvoiceDeliveryEvent(start, { type: "validation_failed", rules: ["DK-R-002"] })
    const sent = [validated, submitted].reduce(applyEinvoiceDeliveryEvent, start)
    const rejectedMessage = applyEinvoiceDeliveryEvent(sent, { type: "receiver_response", response: { kind: "message_rejected", at: at(2), reasons: ["BR-CO-15"] } })
    const rejectedInvoice = applyEinvoiceDeliveryEvent(sent, { type: "receiver_response", response: { kind: "invoice_response", code: "RE", at: at(2), note: null } })
    for (const state of [invalid, rejectedMessage, rejectedInvoice]) {
      expect(einvoiceDeliveryStateSchema.parse(state).documentKind).toBe(documentKind)
      expect(nextEinvoiceDeliveryAction(state)).toBe("review_correction")
    }
    expect(rejectedInvoice.transport).toBe("delivered")
    expect(invalid.transport).toBe("not_sent")
  })

  it.each(["not_registered", "unsupported_document"] as const)("restricts fallback after %s by recipient requirements", (status) => {
    const resolution = einvoiceRecipientResolutionSchema.parse({ status, participant: recipient, checkedAt: at(0), ...(status === "unsupported_document" ? { advertised: ["Procurement-BilSim-1.0"] } : {}) })
    expect(nextEinvoiceRecipientAction("structured_required", resolution)).toBe("alternate_structured_route")
    expect(nextEinvoiceRecipientAction("email_accepted", resolution)).toBe("email_available")
    expect(nextEinvoiceRecipientAction("unknown", resolution)).toBe("confirm_requirement")
  })

  it("does not convert a failed lookup into email permission", () => {
    const failed = einvoiceRecipientResolutionSchema.parse({ status: "lookup_failed", participant: recipient, checkedAt: at(0), retryable: true })
    for (const requirement of ["unknown", "email_accepted", "structured_required"] as const) {
      expect(nextEinvoiceRecipientAction(requirement, failed)).toBe("retry_lookup")
      expect(nextEinvoiceRecipientAction(requirement, einvoiceRecipientResolutionSchema.parse({ ...failed, retryable: false }))).toBe("investigate")
    }
  })
})
