import { lockInvoiceForCompletion } from "./locks"
import { Effect } from "effect"
import type { Prisma } from "../../../generated/prisma/client"
import { createEmailDeliveryAttempt } from "../../lib/email-delivery"
import type { StoredEmailMessage } from "../delivery/outbox"
import {
  enqueueEmailDelivery,
  registerDeliveryCompletion,
  type DeliveryFailure,
} from "../delivery/outbox"
import { pendingCandidate, publishCandidate, retireCandidate } from "./artifacts"
import { InvalidState } from "../errors"
import { Command } from "../services"

/**
 * Emailing invoices, quotes, and credit notes through the outbox. While an email is queued the
 * document's last attempt reads "sending" at the attempt's time; that pair identifies the
 * delivery, and every settlement is conditional on it, so only the delivery that set the marker
 * can clear it.
 *
 * - `send` issues a draft: the document becomes sent (with its issue date and public link date)
 *   only once the provider accepts the email. A refused email leaves an editable draft.
 * - `email` mails a document that is already issued and only records the attempt.
 */

type DocumentKind = "invoice" | "quote" | "creditNote" | "agreement"

type Delegate = {
  count(args: { where: Record<string, unknown> }): Promise<number>
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
}

const config = {
  agreement: { aggregateType: "agreement", noun: "agreement", publicLinkField: "publicAccessIssuedAt" },
  invoice: { aggregateType: "invoice", noun: "invoice", publicLinkField: "publicPaymentIssuedAt" },
  quote: { aggregateType: "quote", noun: "quote", publicLinkField: "publicAccessIssuedAt" },
  creditNote: { aggregateType: "credit_note", noun: "credit note", publicLinkField: null },
} as const satisfies Record<DocumentKind, { aggregateType: string; noun: string; publicLinkField: string | null }>

type Mode = "send" | "email"

function delegate(db: Prisma.TransactionClient, kind: DocumentKind) {
  return db[kind] as unknown as Delegate
}

const completionKind = (kind: DocumentKind, mode: Mode) => `${kind}.${mode}`

/** Events a delivery records when it settles; credit notes are "sent" whenever they are emailed. */
const deliveredEvent = (kind: DocumentKind, mode: Mode): "sent" | "email_resent" =>
  mode === "send" ? "sent" : kind === "creditNote" ? "sent" : "email_resent"

/** The document still waits for this exact delivery. */
function awaiting(target: Record<string, string>, mode: Mode) {
  return {
    id: target.documentId,
    lastEmailAttemptOutcome: "sending",
    lastEmailAttemptAt: new Date(target.attemptAt),
    ...(mode === "send" ? { status: "draft" } : {}),
  }
}

for (const kind of Object.keys(config) as DocumentKind[]) {
  const { aggregateType, noun, publicLinkField } = config[kind]
  /** What sending a draft changes: it is issued at the attempt's time with its public link date. */
  const issuedFields = (target: Record<string, string>, attemptAt: Date) => ({
    status: "sent",
    ...(kind === "agreement" ? {} : { issueDate: target.issuedAt ? new Date(target.issuedAt) : attemptAt }),
    ...(publicLinkField && target.publicLinkIssuedAt ? { [publicLinkField]: new Date(target.publicLinkIssuedAt) } : {}),
  })
  for (const mode of ["send", "email"] as const) {
    registerDeliveryCompletion(completionKind(kind, mode), {
      pending: async (db, target) => (await pendingCandidate(db, target)) && (await delegate(db, kind).count({ where: awaiting(target, mode) })) > 0,
      delivered: async ({ tx, target, organizationId, commandId }) => {
        if (kind === "invoice") await lockInvoiceForCompletion(tx, target.documentId!, organizationId)
        if (!await pendingCandidate(tx, target)) return []
        const attemptAt = new Date(target.attemptAt)
        const issued = mode === "send" ? issuedFields(target, attemptAt) : {}
        const { count } = await delegate(tx, kind).updateMany({
          where: awaiting(target, mode),
          data: {
            ...issued,
            ...createEmailDeliveryAttempt({
              at: attemptAt,
              outcome: "sent",
              code: "sent",
              message: `${noun[0].toUpperCase()}${noun.slice(1)} email sent.`,
            }),
          },
        })
        if (count === 0) return []
        const artifactEvents = target.candidateId ? await publishCandidate(tx, {
          candidateId: target.candidateId, documentId: target.documentId, attemptAt, organizationId, commandId,
        }) : []
        return [
          ...artifactEvents,
          {
            aggregateType,
            aggregateId: target.documentId,
            type: kind === "creditNote" ? "credit_note.sent" : `${kind}.${deliveredEvent(kind, mode)}`,
            payload: {
              number: target.number,
              recipient: target.recipient,
              ...(mode === "send" ? { emailSent: true } : {}),
            },
          },
        ]
      },
      failed: async ({ tx, target, organizationId, commandId }, failure: DeliveryFailure) => {
        if (kind === "invoice") await lockInvoiceForCompletion(tx, target.documentId!, organizationId)
        if (!await pendingCandidate(tx, target)) return []
        const attemptAt = new Date(target.attemptAt)
        if (failure.reason === "unconfirmed") {
          // The customer may have the email, so the document is issued and never reopened.
          const { count } = await delegate(tx, kind).updateMany({
            where: awaiting(target, mode),
            data: {
              ...(mode === "send" ? issuedFields(target, attemptAt) : {}),
              ...createEmailDeliveryAttempt({
                at: attemptAt,
                outcome: "unconfirmed",
                code: "delivery_unconfirmed",
                message: failure.message,
              }),
            },
          })
          if (count === 0) return []
          const artifactEvents = target.candidateId ? await publishCandidate(tx, {
            candidateId: target.candidateId, documentId: target.documentId, attemptAt, organizationId, commandId,
          }) : []
          return [
            ...artifactEvents,
            {
              aggregateType,
              aggregateId: target.documentId,
              type: `${aggregateType}.email_unconfirmed`,
              payload: { number: target.number, recipient: target.recipient, issued: mode === "send" },
            },
          ]
        }
        // Nothing reached the customer, so a draft can be edited and sent again.
        const { count } = await delegate(tx, kind).updateMany({
          where: awaiting(target, mode),
          data: createEmailDeliveryAttempt({
            at: attemptAt,
            outcome: "failed",
            code: "send_failed",
            message:
              failure.reason === "rejected"
                ? `The email provider refused the ${noun} email: ${failure.message}`
                : failure.message,
          }),
        })
        if (count === 0) return []
        await retireCandidate(tx, target, organizationId)
        return [
          {
            aggregateType,
            aggregateId: target.documentId,
            type: `${aggregateType}.email_failed`,
            payload: {
              number: target.number,
              recipient: target.recipient,
              reason: failure.reason,
              message: failure.message,
            },
          },
        ]
      },
    })
  }
}

/** Refuses to start a second email while one for the same document is still being delivered. */
export function refuseWhileSending(kind: DocumentKind, document: { lastEmailAttemptOutcome: string | null }) {
  return document.lastEmailAttemptOutcome === "sending"
    ? Effect.fail(
        new InvalidState({
          message: `This ${config[kind].noun} is already being emailed. Wait for that delivery to finish.`,
          code: "send_in_progress",
        })
      )
    : Effect.void
}

/**
 * Marks the document as being emailed (through `markSending`, so the caller keeps its row type)
 * and queues the rendered message. Returns the updated document and the delivery's key. Must run inside the command after every check passes, with the
 * document locked.
 */
export const queueDocumentEmail = <Row>(input: {
  kind: DocumentKind
  mode: Mode
  document: { id: string; number: string | null }
  recipient: string
  message: StoredEmailMessage
  /** Names exactly this delivery; the provider drops a repeat sent under the same key. */
  idempotencyKey: string
  /** For `send`: the public link date the emailed link was signed with. */
  publicLinkIssuedAt?: Date | null
  markSending: (data: ReturnType<typeof createEmailDeliveryAttempt>) => Promise<Row>
}) =>
  Effect.gen(function* () {
    const { now, issuance } = yield* Command
    const updated = yield* Effect.promise(() =>
      input.markSending(
        createEmailDeliveryAttempt({
          at: now,
          outcome: "sending",
          code: "sending",
          message: `Sending ${config[input.kind].noun} email.`,
        })
      )
    )
    const { deliveryKey } = yield* enqueueEmailDelivery({
      message: input.message,
      idempotencyKey: input.idempotencyKey,
      completion: {
        kind: completionKind(input.kind, input.mode),
        target: {
          ...(issuance ? { candidateId: issuance.candidateId, issuedAt: issuance.issuedAt.toISOString() } : {}),
          documentId: input.document.id,
          attemptAt: now.toISOString(),
          number: input.document.number ?? "",
          recipient: input.recipient,
          ...(input.publicLinkIssuedAt ? { publicLinkIssuedAt: input.publicLinkIssuedAt.toISOString() } : {}),
        },
      },
    })
    return { document: updated, deliveryKey }
  })
