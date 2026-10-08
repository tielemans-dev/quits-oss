import { invoiceIssuedSchema, creditNoteIssuedSchema, baseValuationRecordedSchema } from "./money"
import {
  agreementStatusSchema,
  deliverableStatusSchema,
} from "@quits/contracts/agreements"
import { commandErrorSchema } from "@quits/contracts/agent"
import { paymentMethodSchema } from "@quits/contracts/payments"
import { PAYMENT_DETAILS_FIELDS } from "@quits/contracts/payment-details"
import { z } from "zod"

const s = z.string()
const nullableString = s.nullable()
const n = z.number()
const i = n.int()
const date = z.iso.datetime()
const commandError = commandErrorSchema.extend({
  issues: z.array(z.object({ path: s, message: s }).strict()).optional(),
}).strict()
const fields = z.object({ fields: z.array(s) }).strict()
const number = z.object({ number: s }).strict()
const sent = z.object({ number: s, recipient: nullableString, emailSent: z.boolean().optional() }).strict()
const resent = z.object({ number: s, recipient: s }).strict()
const unconfirmed = z.object({ number: s, recipient: s, issued: z.boolean() }).strict()
const failed = z.object({ number: s, recipient: s, reason: z.enum(["rejected", "withdrawn"]), message: s }).strict()
// Drafts have no number until they are issued, so draft events carry null; later events carry the number.
const draftNumber = z.object({ number: nullableString }).strict()
const draft = z.object({ number: nullableString, contactId: s, totalGross: n }).strict()
const acceptance = z.object({
  acceptedAt: date,
  acceptedRevision: i.nullable(),
  acceptedVia: nullableString,
  acceptanceEvidenceNote: nullableString,
}).strict()
const agreementDecision = { revision: i, hash: nullableString, recipient: nullableString }
const reminderFailure = z.object({ number: s, reminderId: s, reason: s, message: s.optional() }).strict()

const artifactDocumentKind = z.enum(["invoice", "creditNote", "agreement"])
/** A number can also be voided for a quote, which is not rendered as an artifact. */
const voidedDocumentKind = z.enum(["invoice", "quote", "creditNote", "agreement"])
const artifactIdentity = { documentKind: artifactDocumentKind, documentId: s, candidateId: s }
const artifact = z.object({ ref: s.min(1), hash: s.regex(/^[a-f0-9]{64}$/), size: i.nonnegative() }).strict()

/** Serialized v1 shapes, inventoried from the writers. Change a payload only with a version bump. */
export const eventRegistry = {
  "document.artifact_stored": { version: 1, schema: z.object({ ...artifactIdentity,
    artifacts: z.object({ pdf: artifact, ubl: artifact.optional() }).strict(), rendererVersion: s }).strict() },
  "document.artifact_missing": { version: 1, schema: z.object({ ...artifactIdentity, reason: s }).strict() },
  // `reservationId` names the reservation that was abandoned; a deleted draft that held a number has none.
  "document.number_voided": { version: 1, schema: z.object({ organizationId: s, documentKind: voidedDocumentKind,
    number: s, reservationId: s.optional(), reason: s }).strict() },
  "invoice.issued": { version: 1, schema: invoiceIssuedSchema },
  "invoice.base_valuation_recorded": { version: 1, schema: baseValuationRecordedSchema },
  "invoice.draft_created": { version: 1, schema: draft.extend({ quoteId: s.optional() }).strict() },
  "invoice.draft_updated": { version: 1, schema: fields },
  "invoice.draft_deleted": { version: 1, schema: draftNumber },
  "invoice.sent": { version: 1, schema: sent },
  "invoice.email_resent": { version: 1, schema: resent },
  "invoice.email_unconfirmed": { version: 1, schema: unconfirmed },
  "invoice.email_failed": { version: 1, schema: failed },
  "invoice.credited": { version: 1, schema: z.object({ number: s, creditNoteId: s, creditNoteNumber: s }).strict() },
  "invoice.marked_paid": { version: 1, schema: z.object({ paymentId: s, undoUntil: date }).strict() },
  "invoice.paid": { version: 1, schema: z.object({ number: s, amountPaid: s, currency: s }).strict() },
  "invoice.became_overdue": { version: 1, schema: z.object({ number: s, previousStatus: s, dueDate: date, balanceDue: n }).strict() },
  "invoice.reminders_paused": { version: 1, schema: number },
  "invoice.reminders_resumed": { version: 1, schema: number },
  "invoice.reminder_sent": { version: 1, schema: z.object({ number: s, reminderId: s, offsetDays: n, recipient: s, balanceDue: n, manual: z.boolean() }).strict() },
  "invoice.reminder_unconfirmed": { version: 1, schema: reminderFailure },
  "invoice.reminder_failed": { version: 1, schema: reminderFailure },
  "invoice.reminder_skipped": { version: 1, schema: reminderFailure },
  "quote.draft_created": { version: 1, schema: draft },
  "quote.draft_updated": { version: 1, schema: fields },
  "quote.draft_deleted": { version: 1, schema: draftNumber },
  "quote.sent": { version: 1, schema: sent },
  "quote.email_resent": { version: 1, schema: resent },
  "quote.email_unconfirmed": { version: 1, schema: unconfirmed },
  "quote.email_failed": { version: 1, schema: failed },
  "quote.accepted": { version: 1, schema: z.object({ number: s, source: z.literal("customer"), rejectionReason: s.optional() }).strict() },
  "quote.rejected": { version: 1, schema: z.object({ number: s, source: z.enum(["user", "customer"]), rejectionReason: s.optional() }).strict() },
  "quote.converted": { version: 1, schema: z.object({ number: s, invoiceId: s, invoiceNumber: nullableString }).strict() },
  "credit_note.issued": { version: 2, schema: creditNoteIssuedSchema },
  "credit_note.sent": { version: 1, schema: sent },
  "credit_note.email_unconfirmed": { version: 1, schema: unconfirmed },
  "credit_note.email_failed": { version: 1, schema: failed },
  "settlement.evidence_recorded": { version: 1, schema: z.object({ evidenceId: s, sourceId: s, state: z.enum(["reported", "processing", "received", "returned"]), correctsEvidenceId: nullableString, reversesEvidenceId: nullableString }).strict() },
  "settlement.evidence_decided": { version: 1, schema: z.object({ decisionId: s, sourceId: s, evidenceId: s, receiptId: s, action: z.enum(["match", "confirm", "unmatch", "return"]) }).strict() },
  "settlement.receipt_recorded": { version: 1, schema: z.object({ receiptId: s, contactId: s, currency: s, grossAmount: s, netAmount: s, feeAmount: s, paidAt: date, method: paymentMethodSchema, reference: s, reason: s, evidence: s, feeReason: nullableString, feeEvidence: nullableString }).strict() },
  "settlement.allocated": { version: 1, schema: z.object({ receiptId: s, paymentId: s, invoiceId: s, receiptCurrency: s, receiptAmount: s, invoiceCurrency: s, invoiceAmount: s, balanceDue: s, reason: s, evidence: s, exchangeReason: nullableString, exchangeEvidence: nullableString }).strict() },
  "settlement.changed": { version: 1, schema: z.object({ action: z.enum(["refund", "customer_credit", "reverse_allocation", "reverse_refund", "reverse_receipt"]), receiptId: s, targetId: s, currency: s, amount: s, invoiceId: nullableString, invoiceAmount: nullableString, invoiceCurrency: nullableString, reason: s, evidence: s }).strict() },
  "payment.recorded": { version: 1, schema: z.object({ paymentId: s, number: s, amount: s, currency: s, method: paymentMethodSchema, balanceDue: s, paymentStatus: s, overpaidBy: s.optional() }).strict() },
  "payment.failed": { version: 1, schema: z.object({ number: s, method: z.literal("stripe"), checkoutSessionId: s, reason: s, supersededBy: nullableString.optional() }).strict() },
  "payment.voided": { version: 1, schema: z.object({ paymentId: s, number: s, amount: s, currency: s, reason: s, balanceDue: s, paymentStatus: s, status: s }).strict() },
  "contact.created": { version: 1, schema: z.object({ name: s }).strict() },
  "contact.updated": { version: 1, schema: fields },
  "contact.deleted": { version: 1, schema: z.object({ name: s }).strict() },
  "recurring.status_changed": { version: 1, schema: z.object({ from: s, to: s, reason: s }).strict() },
  "recurring.created": { version: 1, schema: z.object({ name: s, contactId: s, status: s, autoSend: z.boolean(), nextRunAt: date }).strict() },
  "recurring.updated": { version: 1, schema: fields },
  "recurring.invoice_generated": { version: 1, schema: z.object({ invoiceId: s, number: nullableString, runDate: s, autoSend: z.boolean() }).strict() },
  "recurring.run_failed": { version: 1, schema: z.object({ runDate: s, error: commandError }).strict() },
  "recurring.auto_send_failed": { version: 1, schema: z.object({ invoiceId: s, error: commandError }).strict() },
  "reminders.policy_updated": { version: 1, schema: z.object({ enabled: z.boolean(), offsetsDays: z.array(i) }).strict() },
  // Masked before/after values only (see lib/payment-details-audit.ts): this change-audit event never holds a full IBAN or account number. `changedBy` names the person by account email and id, not only by the display name they chose.
  "organization.payment_details_updated": { version: 1, schema: z.object({
    changes: z.array(z.object({ field: z.enum(PAYMENT_DETAILS_FIELDS), before: nullableString, after: nullableString }).strict()).min(1),
    changedBy: z.object({ kind: z.enum(["user", "agent", "system"]), id: nullableString, name: s, email: nullableString }).strict(),
  }).strict() },
  "agreement.draft_created": { version: 2, schema: z.object({ title: s, contactId: s, totalGross: n, sourceQuoteId: nullableString }).strict() },
  "agreement_template.created": { version: 1, schema: z.object({ name: s, isDefault: z.boolean() }).strict() },
  "agreement_template.updated": { version: 1, schema: fields },
  "agreement_template.deleted": { version: 1, schema: z.object({ name: s }).strict() },
  "agreement.draft_updated": { version: 1, schema: fields },
  "agreement.draft_deleted": { version: 1, schema: z.object({ title: s, number: nullableString }).strict() },
  "agreement.offer_issued": { version: 1, schema: z.object({ number: s, offerRevision: i, hash: s, recipient: nullableString, method: z.enum(["email", "manual"]), unchangedRetry: z.boolean() }).strict() },
  "agreement.sent": { version: 1, schema: sent },
  "agreement.email_resent": { version: 1, schema: resent },
  "agreement.email_unconfirmed": { version: 1, schema: unconfirmed },
  "agreement.email_failed": { version: 1, schema: failed },
  "agreement.recipient_changed": { version: 1, schema: z.object({ previousRecipient: nullableString, recipient: s, offerRevision: i }).strict() },
  "agreement.offer_recalled": { version: 1, schema: z.object({
    // The writer copies persisted JSON rather than rebuilding a typed offer snapshot.
    snapshot: z.json(), hash: nullableString, recipient: nullableString, revision: i, keyVersion: i,
    decision: z.object({ acceptedAt: date.nullable(), acceptedOfferRevision: i.nullable(), acceptedByName: nullableString, acceptanceIp: nullableString, acceptanceUserAgent: nullableString, acceptanceMethod: nullableString, acceptanceEvidenceNote: nullableString, declinedAt: date.nullable(), declineReason: nullableString }).strict(),
  }).strict() },
  "agreement.accepted": { version: 1, schema: z.discriminatedUnion("method", [
    z.object({ ...agreementDecision, method: z.literal("internal"), name: s, evidenceNote: s }).strict(),
    z.object({ ...agreementDecision, method: z.literal("customer_link"), name: s }).strict(),
  ]) },
  "agreement.declined": { version: 1, schema: z.object({ ...agreementDecision, method: z.literal("customer_link"), reason: nullableString }).strict() },
  "agreement.completed": { version: 1, schema: z.object({ reason: s, previousStatus: agreementStatusSchema }).strict() },
  "deliverable.reserved": { version: 1, schema: z.object({ deliverableId: s, invoiceId: s }).strict() },
  "deliverable.released": { version: 1, schema: z.object({ deliverableId: s, invoiceId: s }).strict() },
  "deliverable.rebill_authorized": { version: 2, schema: z.object({ deliverableId: s, invoiceId: s, creditNoteId: s, creditNoteIds: z.array(s).min(1), generation: i }).strict() },
  "deliverable.invoiced": { version: 1, schema: z.object({ deliverableId: s, invoiceId: s }).strict() },
  "agreement.cancelled": { version: 1, schema: z.object({ reason: s, previousStatus: agreementStatusSchema }).strict() },
  "agreement.links_revoked": { version: 1, schema: z.object({ keyVersion: i }).strict() },
  "agreement.read_link_sent": { version: 1, schema: z.object({ recipient: s, url: s }).strict() },
  "agreement.expired": { version: 1, schema: z.object({}).strict() },
  "deliverable.updated": { version: 1, schema: z.object({ deliverableId: s, fields: z.array(s), previousStatus: deliverableStatusSchema, status: deliverableStatusSchema, deliveryRevision: i, previousAcceptance: acceptance.nullable().optional() }).strict() },
  "deliverable.delivered": { version: 1, schema: z.object({ deliverableId: s, previousStatus: deliverableStatusSchema, deliveryRevision: i, deliveredAt: date, previousAcceptance: acceptance.nullable() }).strict() },
  "deliverable.accepted": { version: 1, schema: z.object({ deliverableId: s, deliveryRevision: i, ...acceptance.shape }).strict() },
  "deliverable.changes_requested": { version: 1, schema: z.object({ deliverableId: s, deliveryRevision: i, note: s, disputedInvoiceIds: z.array(s) }).strict() },
  "invoice.dispute_acknowledged": { version: 1, schema: z.object({ number: s, disputedRevision: i, acknowledgeDisputed: z.literal(true) }).strict() },
  "deliverable.cancelled": { version: 1, schema: z.object({ deliverableId: s, previousStatus: deliverableStatusSchema, deliveryRevision: i, acceptance: acceptance.nullable() }).strict() },
  "approval.requested": { version: 1, schema: z.object({ commandType: s, summary: s }).strict() },
  "approval.rejected": { version: 1, schema: z.object({ commandType: s, note: nullableString }).strict() },
  "approval.approved": { version: 1, schema: z.object({ commandType: s, note: nullableString }).strict() },
  "agent_key.created": { version: 1, schema: z.object({ name: s, mode: s, scopes: z.array(s) }).strict() },
  "agent_key.revoked": { version: 1, schema: z.object({}).strict() },
} as const

export type EventType = keyof typeof eventRegistry
export type EventDefinition = { version: number; schema: z.ZodType }
const testRegistry = new Map<string, EventDefinition>()

export function eventDefinition(type: string): EventDefinition | undefined {
  return Object.hasOwn(eventRegistry, type)
    ? eventRegistry[type as EventType]
    : testRegistry.get(type)
}

/** Test registrations cannot replace production entries. Returns typed keys for test commands. */
export function registerTestEventTypes<T extends Record<string, EventDefinition>>(entries: T) {
  if (process.env.NODE_ENV !== "test") throw new Error("Test event registration requires NODE_ENV=test")
  for (const [type, entry] of Object.entries(entries)) {
    if (!type.startsWith("test.") || eventDefinition(type)) throw new Error(`Cannot register test event ${type}`)
    if (!Number.isInteger(entry.version) || entry.version < 1) throw new Error("Invalid test event version")
  }
  for (const [type, entry] of Object.entries(entries)) testRegistry.set(type, entry)
  return Object.fromEntries(Object.keys(entries).map((type) => [type, type])) as { [K in keyof T]: EventType }
}

export class InvalidEvent extends Error {
  override readonly name = "InvalidEvent"
  constructor(readonly type: string, readonly reason: "unregistered" | "invalid_payload", options?: ErrorOptions) {
    super(`Event ${type}: ${reason}`, options)
  }
}

/** Validation observes exactly the JSON value that will be persisted; it never rewrites it. */
export function serializeEvent(type: string, payload: unknown) {
  const definition = eventDefinition(type)
  if (!definition) throw new InvalidEvent(type, "unregistered")
  let serialized: unknown
  try {
    serialized = JSON.parse(JSON.stringify(payload))
  } catch (cause) {
    throw new InvalidEvent(type, "invalid_payload", { cause })
  }
  const result = definition.schema.safeParse(serialized)
  if (!result.success) throw new InvalidEvent(type, "invalid_payload", { cause: result.error })
  return { schemaVersion: definition.version, payload: serialized }
}
