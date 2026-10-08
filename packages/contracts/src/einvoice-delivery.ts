import { z } from "zod"
import { einvoiceDocumentKindSchema, isPeppolEasCode, type EinvoiceDocumentKind } from "./exports"

/**
 * Provider-neutral lifecycle of one electronic delivery of an issued invoice or credit note.
 * The record design is in docs/plans/2026-10-08-denmark-einvoice-delivery-decision.md.
 *
 * Four concerns are kept apart, because each answers a different question:
 *
 * - `validation`: did the document pass the technical rules (EN 16931, Peppol, national CIUS)?
 * - `transport`: did the receiver's access point acknowledge receipt (Peppol corner 3)?
 * - `receiverResponse`: what did the receiver report back, as a message-level response (MLR) or a
 *   Peppol Invoice Response?
 * - Commercial disputes are not delivery state. A delivered and even accepted invoice can still be
 *   disputed; that belongs to the document's own lifecycle (credit notes, payments, notes).
 */

/** First supported route: Peppol BIS Billing 3.0 with the Danish CIUS, over the Peppol network. */
export const einvoiceDeliveryRouteSchema = z.enum(["peppol_bis_billing_3"])

/** An electronic address (Peppol participant identifier): an EAS scheme and its identifier. */
export const einvoiceParticipantSchema = z.strictObject({
  scheme: z.string().trim().refine(isPeppolEasCode, "Unknown Peppol EAS code"),
  id: z.string().trim().min(1),
})

/**
 * What a registry lookup said about the recipient for the document type about to be sent.
 * `unsupported_document` covers a recipient that is registered, but not for this document type,
 * such as a Danish receiver that only accepts OIOUBL on Nemhandel.
 */
export const einvoiceRecipientResolutionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("reachable"), participant: einvoiceParticipantSchema, checkedAt: z.iso.datetime() }),
  z.strictObject({ status: z.literal("not_registered"), participant: einvoiceParticipantSchema, checkedAt: z.iso.datetime() }),
  z.strictObject({
    status: z.literal("unsupported_document"),
    participant: einvoiceParticipantSchema,
    checkedAt: z.iso.datetime(),
    /** The profiles or document types the recipient does advertise, as the registry names them. */
    advertised: z.array(z.string().trim().min(1)),
  }),
  z.strictObject({
    status: z.literal("lookup_failed"),
    participant: einvoiceParticipantSchema,
    checkedAt: z.iso.datetime(),
    retryable: z.boolean(),
  }),
])

/** Established independently of registry lookup, from recipient requirements and applicable rules. */
export const einvoiceRecipientRequirementSchema = z.enum(["unknown", "structured_required", "email_accepted"])

export type EinvoiceRecipientRequirement = z.infer<typeof einvoiceRecipientRequirementSchema>
export type EinvoiceRecipientAction =
  | "use_structured_route" | "alternate_structured_route" | "email_available" | "confirm_requirement" | "retry_lookup" | "investigate"

/** Route advice only. Neither an email copy nor this decision completes a structured delivery. */
export function nextEinvoiceRecipientAction(
  requirement: EinvoiceRecipientRequirement,
  resolution: EinvoiceRecipientResolution,
): EinvoiceRecipientAction {
  if (resolution.status === "reachable") return "use_structured_route"
  if (resolution.status === "lookup_failed") return resolution.retryable ? "retry_lookup" : "investigate"
  if (requirement === "structured_required") return "alternate_structured_route"
  return requirement === "email_accepted" ? "email_available" : "confirm_requirement"
}

export const einvoiceValidationStateSchema = z.enum(["not_run", "passed", "failed"])

/**
 * `queued`: handed to the provider, no transport outcome yet.
 * `delivered`: the receiving access point acknowledged receipt. Not acceptance.
 * `no_route`: the network had no receiver for this participant and document type.
 * `unknown`: the submission's outcome is uncertain (for example a timeout before the provider
 * answered). It must be reconciled with the provider; resending could deliver the invoice twice.
 */
export const einvoiceTransportStateSchema = z.enum(["not_sent", "queued", "delivered", "no_route", "failed", "unknown"])

/**
 * Peppol Invoice Response status codes (UNCL 4343 subset used by Peppol BIS Invoice Response 3).
 * AB acknowledged, IP in process, UQ under query, CA conditionally accepted, RE rejected,
 * AP accepted, PD fully paid.
 */
export const invoiceResponseCodeSchema = z.enum(["AB", "IP", "UQ", "CA", "RE", "AP", "PD"])

export const einvoiceReceiverResponseSchema = z.discriminatedUnion("kind", [
  /** A message-level rejection: the receiving side found the document technically invalid. */
  z.strictObject({ kind: z.literal("message_rejected"), at: z.iso.datetime(), reasons: z.array(z.string().trim().min(1)) }),
  z.strictObject({ kind: z.literal("invoice_response"), code: invoiceResponseCodeSchema, at: z.iso.datetime(), note: z.string().nullable() }),
])

export const einvoiceDeliveryStateSchema = z.strictObject({
  documentKind: einvoiceDocumentKindSchema,
  route: einvoiceDeliveryRouteSchema,
  recipient: einvoiceParticipantSchema,
  validation: einvoiceValidationStateSchema,
  /** Rule identifiers that failed, such as `PEPPOL-EN16931-R003` or `DK-R-002`. */
  validationErrors: z.array(z.string().trim().min(1)),
  transport: einvoiceTransportStateSchema,
  /** Stable across reconciliation; an explicitly acknowledged retry may use a new reference. */
  providerReference: z.string().trim().min(1).nullable(),
  transportCode: z.string().trim().min(1).nullable(),
  transportRetryable: z.boolean(),
  deliveredAt: z.iso.datetime().nullable(),
  receiverResponse: einvoiceReceiverResponseSchema.nullable(),
})

export const einvoiceDeliveryEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("validation_passed") }),
  z.strictObject({ type: z.literal("validation_failed"), rules: z.array(z.string().trim().min(1)).min(1) }),
  z.strictObject({ type: z.literal("submitted"), providerReference: z.string().trim().min(1) }),
  /** Trusted lookup of the original submission confirms it is queued. Does not authorize a send. */
  z.strictObject({ type: z.literal("submission_reconciled"), providerReference: z.string().trim().min(1) }),
  /** Acknowledges a permitted retry, correlated to that retry rather than an old callback. */
  z.strictObject({ type: z.literal("retry_submitted"), providerReference: z.string().trim().min(1) }),
  z.strictObject({ type: z.literal("submission_outcome_unknown") }),
  z.strictObject({ type: z.literal("transport_delivered"), at: z.iso.datetime() }),
  z.strictObject({ type: z.literal("transport_no_route"), code: z.string().trim().min(1) }),
  z.strictObject({ type: z.literal("transport_failed"), code: z.string().trim().min(1), retryable: z.boolean() }),
  z.strictObject({ type: z.literal("receiver_response"), response: einvoiceReceiverResponseSchema }),
])

export type EinvoiceDeliveryRoute = z.infer<typeof einvoiceDeliveryRouteSchema>
export type EinvoiceParticipant = z.infer<typeof einvoiceParticipantSchema>
export type EinvoiceRecipientResolution = z.infer<typeof einvoiceRecipientResolutionSchema>
export type EinvoiceTransportState = z.infer<typeof einvoiceTransportStateSchema>
export type InvoiceResponseCode = z.infer<typeof invoiceResponseCodeSchema>
export type EinvoiceReceiverResponse = z.infer<typeof einvoiceReceiverResponseSchema>
export type EinvoiceDeliveryState = z.infer<typeof einvoiceDeliveryStateSchema>
export type EinvoiceDeliveryEvent = z.infer<typeof einvoiceDeliveryEventSchema>

/** An event that cannot follow the current state; the caller keeps the state and records why. */
export class EinvoiceDeliveryTransitionError extends Error {
  constructor(readonly code: "not_validated" | "already_submitted" | "transport_settled" | "response_settled" | "reference_mismatch", message: string) {
    super(message)
  }
}

export function initialEinvoiceDeliveryState(route: EinvoiceDeliveryRoute, recipient: EinvoiceParticipant, documentKind: EinvoiceDocumentKind): EinvoiceDeliveryState {
  return {
    route, recipient, documentKind, validation: "not_run", validationErrors: [], transport: "not_sent", providerReference: null,
    transportCode: null, transportRetryable: false, deliveredAt: null, receiverResponse: null,
  }
}

/** Invoice Response codes after which the receiver sends nothing further for this invoice. */
const FINAL_INVOICE_RESPONSES: ReadonlySet<InvoiceResponseCode> = new Set(["RE", "PD"])

function responseIsFinal(response: EinvoiceReceiverResponse | null) {
  if (!response) return false
  return response.kind === "message_rejected" || FINAL_INVOICE_RESPONSES.has(response.code)
}

/**
 * Applies one provider or validator event. Callbacks can arrive late, twice or out of order:
 * duplicates are no-ops, an older receiver response never replaces a newer one, and a receiver
 * response before the transport receipt implies delivery.
 */
export function applyEinvoiceDeliveryEvent(state: EinvoiceDeliveryState, event: EinvoiceDeliveryEvent): EinvoiceDeliveryState {
  switch (event.type) {
    case "validation_passed":
    case "validation_failed": {
      if (state.transport !== "not_sent") {
        throw new EinvoiceDeliveryTransitionError("already_submitted", "Validation cannot change after submission")
      }
      return event.type === "validation_passed"
        ? { ...state, validation: "passed", validationErrors: [] }
        : { ...state, validation: "failed", validationErrors: [...event.rules] }
    }
    case "submitted": {
      if (state.validation !== "passed") {
        throw new EinvoiceDeliveryTransitionError("not_validated", "Only a validated document can be submitted")
      }
      if (state.transport !== "unknown" && state.providerReference === event.providerReference) return state
      if (state.transport !== "not_sent") {
        throw new EinvoiceDeliveryTransitionError("already_submitted", "The document was already submitted")
      }
      return { ...state, transport: "queued", providerReference: event.providerReference, transportCode: null, transportRetryable: false }
    }
    case "submission_reconciled":
    case "retry_submitted": {
      if (state.validation !== "passed") {
        throw new EinvoiceDeliveryTransitionError("not_validated", "Only a validated submission can be acknowledged")
      }
      if (event.type === "submission_reconciled" && state.providerReference !== null && state.providerReference !== event.providerReference) {
        throw new EinvoiceDeliveryTransitionError("reference_mismatch", "Reconciliation must match the original provider reference")
      }
      if (state.transport === "queued" && state.providerReference === event.providerReference) return state
      const allowed = event.type === "submission_reconciled"
        ? state.transport === "unknown"
        : state.transport === "failed" && state.transportRetryable
      if (!allowed) {
        throw new EinvoiceDeliveryTransitionError("transport_settled", "Queued evidence cannot reopen this transport state")
      }
      return { ...state, transport: "queued", providerReference: event.providerReference, transportCode: null, transportRetryable: false }
    }
    case "submission_outcome_unknown": {
      if (state.transport === "delivered" || state.transport === "no_route") return state
      if (state.validation !== "passed") {
        throw new EinvoiceDeliveryTransitionError("not_validated", "Only a validated document can be submitted")
      }
      return { ...state, transport: "unknown", transportRetryable: false }
    }
    case "transport_delivered": {
      if (state.transport === "delivered") return state
      if (state.transport === "no_route") {
        throw new EinvoiceDeliveryTransitionError("transport_settled", "A document without a route cannot be delivered")
      }
      return { ...state, transport: "delivered", deliveredAt: event.at, transportCode: null, transportRetryable: false }
    }
    case "transport_no_route":
    case "transport_failed": {
      if (state.transport === "delivered") {
        throw new EinvoiceDeliveryTransitionError("transport_settled", "A delivered document cannot fail transport")
      }
      return event.type === "transport_no_route"
        ? { ...state, transport: "no_route", transportCode: event.code, transportRetryable: false }
        : { ...state, transport: "failed", transportCode: event.code, transportRetryable: event.retryable }
    }
    case "receiver_response": {
      const current = state.receiverResponse
      const delivered = state.transport === "delivered"
        ? state
        : { ...state, transport: "delivered" as const, deliveredAt: event.response.at, transportCode: null, transportRetryable: false }
      if (current && Date.parse(event.response.at) < Date.parse(current.at)) return delivered
      if (current && JSON.stringify(current) === JSON.stringify(event.response)) return delivered
      if (responseIsFinal(current)) {
        throw new EinvoiceDeliveryTransitionError("response_settled", "The receiver already gave a final response")
      }
      return { ...delivered, receiverResponse: event.response }
    }
  }
}

/**
 * What the sender should do next.
 *
 * - `submit`: validated and never sent.
 * - `reconcile`: ask the provider about the existing submission; never send a second copy.
 * - `resubmit`: the provider confirmed non-delivery and that retry is safe under its retry contract.
 * - `fix_recipient`: no route, or the recipient is not registered for this document.
 * - `investigate`: the provider reported a failure that sending again will not fix.
 * - `review_correction`: investigate validation or rejection of the immutable issued artifact.
 *   This never authorizes a financial command, for either an invoice or a credit note.
 * - `wait`: in transit, or delivered and awaiting the receiver.
 * - `none`: nothing more to do for this delivery.
 */
export type EinvoiceDeliveryAction =
  | "submit" | "reconcile" | "resubmit" | "fix_recipient" | "investigate" | "review_correction" | "wait" | "none"

export function nextEinvoiceDeliveryAction(state: EinvoiceDeliveryState): EinvoiceDeliveryAction {
  if (state.validation === "failed") return "review_correction"
  const response = state.receiverResponse
  if (response?.kind === "message_rejected" || (response?.kind === "invoice_response" && response.code === "RE")) {
    return "review_correction"
  }
  switch (state.transport) {
    case "not_sent": return state.validation === "passed" ? "submit" : "none"
    case "queued": return "wait"
    case "unknown": return "reconcile"
    case "failed": return state.transportRetryable ? "resubmit" : "investigate"
    case "no_route": return "fix_recipient"
    case "delivered": return response && responseIsFinal(response) ? "none" : "wait"
  }
}
