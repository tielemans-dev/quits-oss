import { z } from "zod"
import { isPeppolEasCode } from "./exports"

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
  route: einvoiceDeliveryRouteSchema,
  recipient: einvoiceParticipantSchema,
  validation: einvoiceValidationStateSchema,
  /** Rule identifiers that failed, such as `PEPPOL-EN16931-R003` or `DK-R-002`. */
  validationErrors: z.array(z.string().trim().min(1)),
  transport: einvoiceTransportStateSchema,
  /** The provider's reference for the submission; stable across status reconciliation. */
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
  constructor(readonly code: "not_validated" | "already_submitted" | "transport_settled" | "response_settled", message: string) {
    super(message)
  }
}

export function initialEinvoiceDeliveryState(route: EinvoiceDeliveryRoute, recipient: EinvoiceParticipant): EinvoiceDeliveryState {
  return {
    route, recipient, validation: "not_run", validationErrors: [], transport: "not_sent", providerReference: null,
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
      if (state.providerReference === event.providerReference) return state
      if (state.transport !== "not_sent" && !(state.transport === "failed" && state.transportRetryable)) {
        throw new EinvoiceDeliveryTransitionError("already_submitted", "The document was already submitted")
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
 * - `resubmit`: the provider reported a retryable failure; the same document may be sent again.
 * - `fix_recipient`: no route, or the recipient is not registered for this document.
 * - `investigate`: the provider reported a failure that sending again will not fix.
 * - `credit_and_reissue`: the issued document was rejected (failed validation, MLR rejection or
 *   Invoice Response RE). It is not edited: a credit note cancels it and a corrected invoice follows.
 * - `wait`: in transit, or delivered and awaiting the receiver.
 * - `none`: nothing more to do for this delivery.
 */
export type EinvoiceDeliveryAction =
  | "submit" | "reconcile" | "resubmit" | "fix_recipient" | "investigate" | "credit_and_reissue" | "wait" | "none"

export function nextEinvoiceDeliveryAction(state: EinvoiceDeliveryState): EinvoiceDeliveryAction {
  if (state.validation === "failed") return "credit_and_reissue"
  const response = state.receiverResponse
  if (response?.kind === "message_rejected" || (response?.kind === "invoice_response" && response.code === "RE")) {
    return "credit_and_reissue"
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
