import { Effect } from "effect"
import { z } from "zod"
import type { Prisma } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"
import { deliver, EmailSendError, type EmailMessage } from "../../lib/email"
import { appLogger } from "../../lib/observability"
import type { Actor } from "../actor"
import { appendEvents } from "../events"
import { registerJobHandler } from "../jobs"
import { Command, type PendingEvent } from "../services"

/**
 * The email outbox. A command that emails a customer renders the exact message, records that the
 * document is being sent, and queues the message in the same transaction. The delivery job runs
 * right after that transaction commits, so a normal send still finishes within the request, and
 * then settles the document:
 *
 * - The provider accepted the message: the completion's `delivered` step runs (e.g. the invoice
 *   becomes sent).
 * - The provider definitely rejected it: nothing was delivered, so `rejected` runs and the
 *   document can be edited and sent again.
 * - Anything else (timeout, lost response, provider outage) may have delivered it: the job
 *   retries the identical stored message under the same provider idempotency key, so the
 *   provider drops a duplicate. Only once retries are used up is the delivery given up as
 *   unconfirmed.
 *
 * Because the stored message is what gets retried, a retry can never send different content, and
 * because each settlement is conditional on the document still waiting for this delivery, an
 * older delivery can never settle a newer one.
 */

export const EMAIL_DELIVERY_JOB = "email.deliver"
/**
 * Delivery attempts before an unconfirmed delivery is given up. One below the job runner's limit
 * (5), so a runner that stops mid-attempt is retried once more instead of failing the job without
 * settling the document.
 */
export const EMAIL_DELIVERY_ATTEMPTS = 4

const deliveryLogger = appLogger.child("email-delivery")

/**
 * Provider errors that do not prove the message was refused: the provider may have accepted it,
 * or will accept it when retried with the same key.
 */
const UNCERTAIN_PROVIDER_ERRORS = new Set([
  "application_error",
  "internal_server_error",
  "rate_limit_exceeded",
  "concurrent_idempotent_requests",
  // The key was already used for a different message; only an earlier attempt can have used it,
  // so whether that attempt delivered is unknown.
  "invalid_idempotent_request",
])

/** True when the provider refused the message, so nothing was delivered. */
export function isDefiniteRejection(error: unknown): error is EmailSendError {
  return error instanceof EmailSendError && !UNCERTAIN_PROVIDER_ERRORS.has(error.providerCode)
}

/** The message as stored in the outbox; replayed unchanged on every attempt. */
const storedMessageSchema = z.object({
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  html: z.string(),
  replyTo: z.string().optional(),
})
export type StoredEmailMessage = z.infer<typeof storedMessageSchema>

const payloadSchema = z.object({
  message: storedMessageSchema,
  idempotencyKey: z.string().min(1),
  completion: z.object({ kind: z.string().min(1), target: z.record(z.string(), z.string()) }),
  actor: z.custom<Actor>((value) => typeof value === "object" && value !== null && "kind" in value),
  commandId: z.string(),
  approvedByUserId: z.string().nullable(),
})
type DeliveryPayload = z.infer<typeof payloadSchema>

export type DeliveryRejection = {
  /** `rejected`: the provider refused the message. `unconfirmed`: retries ran out. */
  reason: "rejected" | "unconfirmed"
  message: string
}

export type DeliveryContext = {
  tx: Prisma.TransactionClient
  organizationId: string
  target: Record<string, string>
  now: Date
}

/**
 * What a delivery does to its document. Each step returns the events to record, attributed to
 * whoever ran the original command, and must only change a document still waiting for this
 * delivery (checked with `pending`), so a delivery that already settled is never applied twice.
 */
export type DeliveryCompletion = {
  /** Whether the document is still waiting for this delivery; checked before every attempt. */
  pending: (db: Prisma.TransactionClient, target: Record<string, string>) => Promise<boolean>
  delivered: (context: DeliveryContext) => Promise<PendingEvent[]>
  rejected: (context: DeliveryContext, rejection: DeliveryRejection) => Promise<PendingEvent[]>
}

const completions = new Map<string, DeliveryCompletion>()

export function registerDeliveryCompletion(kind: string, completion: DeliveryCompletion) {
  completions.set(kind, completion)
}

/** The outbox key of one delivery; also how callers find its job after the command commits. */
export function deliveryKey(idempotencyKey: string) {
  return `email:${idempotencyKey}`
}

/**
 * Queues an email in the running command. `idempotencyKey` must name exactly this delivery and
 * stay the same if the command is retried, so the provider recognizes a repeat.
 */
export const enqueueEmailDelivery = (input: {
  message: EmailMessage & StoredEmailMessage
  idempotencyKey: string
  completion: { kind: string; target: Record<string, string> }
}) =>
  Effect.gen(function* () {
    const command = yield* Command
    const message: StoredEmailMessage = {
      from: input.message.from,
      to: input.message.to,
      subject: input.message.subject,
      html: input.message.html,
      ...(input.message.replyTo ? { replyTo: input.message.replyTo } : {}),
    }
    const payload: DeliveryPayload = {
      message,
      idempotencyKey: input.idempotencyKey,
      completion: input.completion,
      actor: command.actor,
      commandId: command.commandId,
      approvedByUserId: command.approvedByUserId,
    }
    const key = deliveryKey(input.idempotencyKey)
    command.enqueue({ type: EMAIL_DELIVERY_JOB, payload, dedupeKey: key })
    return { deliveryKey: key }
  })

async function settle(
  job: { organizationId: string },
  payload: DeliveryPayload,
  completion: DeliveryCompletion,
  outcome: { delivered: true } | { delivered: false; rejection: DeliveryRejection }
) {
  const now = new Date()
  await prisma.$transaction(async (tx) => {
    // Settles only a document still waiting for this delivery; the completion locks it first.
    const context = { tx, organizationId: job.organizationId, target: payload.completion.target, now }
    const events = outcome.delivered
      ? await completion.delivered(context)
      : await completion.rejected(context, outcome.rejection)
    await appendEvents(tx, {
      organizationId: job.organizationId,
      actor: payload.actor,
      commandId: payload.commandId,
      approvedByUserId: payload.approvedByUserId,
      occurredAt: now,
      events,
    })
  })
}

registerJobHandler(EMAIL_DELIVERY_JOB, async (job) => {
  const payload = payloadSchema.parse(job.payload)
  const completion = completions.get(payload.completion.kind)
  if (!completion) {
    throw new Error(`No delivery completion registered for ${payload.completion.kind}`)
  }
  if (!(await completion.pending(prisma, payload.completion.target))) {
    return
  }

  try {
    await deliver(payload.message, { idempotencyKey: payload.idempotencyKey })
  } catch (error) {
    if (isDefiniteRejection(error)) {
      deliveryLogger.warn("email.rejected", { kind: payload.completion.kind, providerCode: error.providerCode })
      await settle(job, payload, completion, {
        delivered: false,
        rejection: { reason: "rejected", message: error.message },
      })
      return
    }
    if (job.attempts >= EMAIL_DELIVERY_ATTEMPTS) {
      deliveryLogger.error("email.unconfirmed", { kind: payload.completion.kind, error })
      await settle(job, payload, completion, {
        delivered: false,
        rejection: {
          reason: "unconfirmed",
          message: "The email provider never confirmed delivery; the email may not have arrived.",
        },
      })
      return
    }
    // Retried with backoff by the job runner, replaying the same message and key.
    throw error
  }

  await settle(job, payload, completion, { delivered: true })
})
