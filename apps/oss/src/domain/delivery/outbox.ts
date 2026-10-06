import { Effect } from "effect"
import { z } from "zod"
import { Prisma } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"
import { deliver, EmailSendError, type EmailMessage } from "../../lib/email"
import { appLogger } from "../../lib/observability"
import type { Actor } from "../actor"
import { appendEvents } from "../events"
import { registerJobHandler, TerminalJobError } from "../jobs"
import { registerTickTask, type TickOptions } from "../scheduler"
import { Command, type PendingEvent } from "../services"

/**
 * The email outbox. A command that emails a customer renders the exact message, records that the
 * document is being sent, and queues the message in the same transaction. The delivery job runs
 * right after that transaction commits (or in the next sweep for background work), then settles
 * the document exactly once with one of these outcomes, stored on the job:
 *
 * - `delivered`: the provider accepted the message.
 * - `rejected`: the provider refused the only request ever made, so nothing was delivered and the
 *   document can be changed and sent again.
 * - `unconfirmed`: an earlier request may have been accepted (a timeout, a lost response, an
 *   outage, a runner that stopped) and no request ever confirmed it. The customer may have the
 *   email, so the document is treated as sent but marked unconfirmed, never reopened.
 * - `withdrawn`: the email is no longer wanted (e.g. the invoice was paid before a reminder went
 *   out) and no request had been made yet.
 *
 * Uncertain failures are retried with the identical stored message under the same provider
 * idempotency key, so the provider drops a duplicate, but only while that key is still honored.
 * A provider acceptance is recorded on the job before the document is settled, so a failed
 * settlement is retried without contacting the provider again; deliveries whose job died without
 * settling are settled by a scheduler sweep. Settlement is conditional on the document still
 * waiting for this delivery, so a delivery can never settle a newer attempt.
 */

export const EMAIL_DELIVERY_JOB = "email.deliver"
/**
 * Delivery attempts before an unconfirmed delivery is given up. One below the job runner's limit
 * (5), so a runner that stops mid-attempt is retried once more before the job fails.
 */
export const EMAIL_DELIVERY_ATTEMPTS = 4
/**
 * The provider honors an idempotency key for 24 hours. After an uncertain attempt no request is
 * made once this much time has passed, because a retry could then deliver a second copy.
 */
export const IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000

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

/** True when the provider refused this request, so this request delivered nothing. */
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
  /** Set once the provider accepted the message, before the document is settled. */
  providerMessageId: z.string().optional(),
})
type DeliveryPayload = z.infer<typeof payloadSchema>

export type DeliveryFailure = {
  reason: "rejected" | "unconfirmed" | "withdrawn"
  message: string
}

const resultSchema = z.object({
  outcome: z.enum(["delivered", "rejected", "unconfirmed", "withdrawn"]),
  message: z.string().nullable(),
})
export type DeliveryResult = z.infer<typeof resultSchema>

export type DeliveryContext = {
  tx: Prisma.TransactionClient
  organizationId: string
  target: Record<string, string>
  now: Date
}

/**
 * What a delivery does to its document. Each step returns the events to record, attributed to
 * whoever ran the original command, and must only change a document still waiting for this
 * delivery (the same condition `pending` checks).
 */
export type DeliveryCompletion = {
  /** Whether the document is still waiting for this delivery; checked before every attempt. */
  pending: (db: Prisma.TransactionClient, target: Record<string, string>) => Promise<boolean>
  /**
   * Why the email should no longer go out, checked before every request to the provider, or null
   * to send it. Omit when the email is always wanted.
   */
  withdrawalReason?: (db: Prisma.TransactionClient, target: Record<string, string>) => Promise<string | null>
  delivered: (context: DeliveryContext) => Promise<PendingEvent[]>
  failed: (context: DeliveryContext, failure: DeliveryFailure) => Promise<PendingEvent[]>
}

const completions = new Map<string, DeliveryCompletion>()

export function registerDeliveryCompletion(kind: string, completion: DeliveryCompletion) {
  completions.set(kind, completion)
}

/** The outbox key of one delivery: its job's dedupe key, and how callers look up its outcome. */
export function deliveryKey(idempotencyKey: string) {
  return `email:${idempotencyKey}`
}

/**
 * Queues an email in the running command. `idempotencyKey` must name exactly this delivery.
 * Returns the delivery key, which identifies this delivery's outcome independently of any later
 * attempt on the same document.
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

/** Settles the document and records the outcome on the job, in one transaction. */
async function settle(
  job: { id: string; organizationId: string },
  payload: DeliveryPayload,
  completion: DeliveryCompletion,
  outcome: { delivered: true } | { delivered: false; failure: DeliveryFailure }
) {
  const now = new Date()
  await prisma.$transaction(async (tx) => {
    const context = { tx, organizationId: job.organizationId, target: payload.completion.target, now }
    const events = outcome.delivered
      ? await completion.delivered(context)
      : await completion.failed(context, outcome.failure)
    await appendEvents(tx, {
      organizationId: job.organizationId,
      actor: payload.actor,
      commandId: payload.commandId,
      approvedByUserId: payload.approvedByUserId,
      occurredAt: now,
      events,
    })
    const result: DeliveryResult = outcome.delivered
      ? { outcome: "delivered", message: null }
      : { outcome: outcome.failure.reason, message: outcome.failure.message }
    await tx.job.update({ where: { id: job.id }, data: { result } })
  })
}

const UNCONFIRMED_MESSAGE =
  "The email provider never confirmed delivery, so the customer may or may not have received it."

/** Settles a failure and reports it to the job runner as permanent, so it counts as failed. */
async function settleFailure(
  job: { id: string; organizationId: string },
  payload: DeliveryPayload,
  completion: DeliveryCompletion,
  failure: DeliveryFailure
): Promise<never> {
  await settle(job, payload, completion, { delivered: false, failure })
  throw new TerminalJobError(`Email ${failure.reason}: ${failure.message}`)
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
  // Accepted by an earlier attempt whose settlement failed: settle without sending again.
  if (payload.providerMessageId) {
    await settle(job, payload, completion, { delivered: true })
    return
  }

  // Every earlier attempt ended without an answer (a definite answer would have settled it), so
  // any of them may have been delivered.
  const possiblyDelivered = job.attempts > 1
  if (possiblyDelivered && Date.now() - job.createdAt.getTime() >= IDEMPOTENCY_WINDOW_MS) {
    return settleFailure(job, payload, completion, { reason: "unconfirmed", message: UNCONFIRMED_MESSAGE })
  }
  const withdrawal = await completion.withdrawalReason?.(prisma, payload.completion.target)
  if (withdrawal) {
    if (possiblyDelivered) {
      return settleFailure(job, payload, completion, {
        reason: "unconfirmed",
        message: `${UNCONFIRMED_MESSAGE} Further attempts were stopped: ${withdrawal}`,
      })
    }
    await settle(job, payload, completion, {
      delivered: false,
      failure: { reason: "withdrawn", message: withdrawal },
    })
    return
  }

  let accepted: { id: string }
  try {
    accepted = await deliver(payload.message, { idempotencyKey: payload.idempotencyKey })
  } catch (error) {
    if (isDefiniteRejection(error)) {
      deliveryLogger.warn("email.rejected", { kind: payload.completion.kind, providerCode: error.providerCode })
      // A refusal proves only that this request delivered nothing.
      return settleFailure(
        job,
        payload,
        completion,
        possiblyDelivered
          ? { reason: "unconfirmed", message: UNCONFIRMED_MESSAGE }
          : { reason: "rejected", message: error.message }
      )
    }
    if (job.attempts >= EMAIL_DELIVERY_ATTEMPTS) {
      deliveryLogger.error("email.unconfirmed", { kind: payload.completion.kind, error })
      return settleFailure(job, payload, completion, { reason: "unconfirmed", message: UNCONFIRMED_MESSAGE })
    }
    // Retried with backoff by the job runner, replaying the same message and key.
    throw error
  }

  // Recorded first, so a settlement that fails is retried without sending again.
  await prisma.job.update({
    where: { id: job.id },
    data: { payload: { ...payload, providerMessageId: accepted.id } },
  })
  await settle(job, payload, completion, { delivered: true })
})

/**
 * Settles deliveries whose job ended without settling: a runner that stopped on the last allowed
 * attempt, or a settlement that kept failing. An accepted message settles as delivered; anything
 * else may have been delivered, so it settles as unconfirmed. Runs on every scheduler tick.
 */
export async function settleAbandonedDeliveries(input: { organizationIds?: readonly string[]; limit?: number } = {}) {
  const abandoned = await prisma.job.findMany({
    where: {
      type: EMAIL_DELIVERY_JOB,
      status: "failed",
      result: { equals: Prisma.DbNull },
      ...(input.organizationIds ? { organizationId: { in: [...input.organizationIds] } } : {}),
    },
    orderBy: { updatedAt: "asc" },
    take: input.limit ?? 100,
  })

  let settled = 0
  let failed = 0
  for (const job of abandoned) {
    try {
      const payload = payloadSchema.parse(job.payload)
      const completion = completions.get(payload.completion.kind)
      if (!completion) throw new Error(`No delivery completion registered for ${payload.completion.kind}`)
      if (!(await completion.pending(prisma, payload.completion.target))) {
        // Nothing left to settle; recorded so the sweep does not look at this job again.
        await prisma.job.update({
          where: { id: job.id },
          data: { result: { outcome: "unconfirmed", message: "The document no longer waited for this delivery" } },
        })
        continue
      }
      await settle(
        job,
        payload,
        completion,
        payload.providerMessageId
          ? { delivered: true }
          : { delivered: false, failure: { reason: "unconfirmed", message: UNCONFIRMED_MESSAGE } }
      )
      settled += 1
    } catch (error) {
      failed += 1
      deliveryLogger.error("email.settle_abandoned_failed", { jobId: job.id, error })
    }
  }
  return { abandoned: abandoned.length, settled, failed }
}

registerTickTask({
  name: "email-deliveries",
  // After the jobs sweep, so deliveries it just gave up on are settled in the same tick.
  order: 1100,
  run: (_now: Date, options?: TickOptions) => settleAbandonedDeliveries({ organizationIds: options?.organizationIds }),
})

/**
 * The outcome of one delivery, identified by its key: `pending` until it settles. Unaffected by
 * later deliveries for the same document.
 */
export async function readDeliveryResult(
  key: string
): Promise<DeliveryResult | { outcome: "pending"; message: null }> {
  const job = await prisma.job.findUnique({ where: { dedupeKey: key }, select: { result: true } })
  const parsed = resultSchema.safeParse(job?.result)
  return parsed.success ? parsed.data : { outcome: "pending", message: null }
}
