import { Effect } from "effect"
import { z } from "zod"
import { Prisma } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"
import { deliver, EmailSendError, ensureEmailProvider, type EmailMessage } from "../../lib/email"
import { selectedEmailProvider } from "../../lib/email-provider-config"
import { appLogger } from "../../lib/observability"
import type { Actor } from "../actor"
import { appendEvents } from "../events"
import { registerJobHandler, StaleJobClaimError, TerminalJobError } from "../jobs"
import { registerTickTask, type TickOptions } from "../scheduler"
import { lockArtifactOrganization } from "../documents/artifacts"
import { Command, type PendingEvent } from "../services"
import { NEVER_SENT_MESSAGE, NOT_CONFIGURED_MESSAGE, emailProviderFailureCodeSchema, emailProviderFailureMessage, type EmailProviderFailureCode } from "./provider-failure"

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
 * Resend retries uncertain failures with the identical stored message and idempotency key while
 * the key is still honored. SMTP cannot deduplicate, so an uncertain SMTP request is never retried.
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

/**
 * A provider request that has not answered after this long is treated as unanswered (it may still
 * be accepted, so it is retried under the same key), so a hung request cannot hold the job past
 * its lease or the key past its window.
 */
const PROVIDER_TIMEOUT_MS = 60_000

const deliveryLogger = appLogger.child("email-delivery")

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The email provider did not answer within ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Provider errors that do not prove the message was refused: the provider may have accepted it,
 * or will accept it when retried with the same key.
 */
const UNCERTAIN_PROVIDER_ERRORS = new Set([
  "smtp_partial_acceptance",
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

export const deliveryPayloadSchema = z.object({
  message: storedMessageSchema,
  idempotencyKey: z.string().min(1),
  completion: z.object({ kind: z.string().min(1), target: z.record(z.string(), z.string()) }),
  actor: z.custom<Actor>((value) => typeof value === "object" && value !== null && "kind" in value),
  commandId: z.string(),
  approvedByUserId: z.string().nullable(),
  /** Set once the provider accepted the message, before the document is settled. */
  providerMessageId: z.string().optional(),
  /** Requests started with the provider, counted before each request is made. */
  requests: z.number().int().optional(),
  /** Pinned before the first request. Legacy requests without this field used Resend. */
  provider: z.enum(["resend", "smtp"]).optional(),
  recoveryOf: z.string().optional(),
  manualReason: z.string().optional(),
  attempts: z.array(z.object({
    startedAt: z.string(),
    outcome: z.enum(["started", "accepted", "rejected", "uncertain"]),
    providerMessageId: z.string().optional(),
  })).optional(),
  evidence: z.array(z.object({
    evidenceId: z.string(), observedAt: z.string(),
    outcome: z.enum(["accepted", "unknown"]), providerMessageId: z.string().optional(),
  })).optional(),
  /** A failure decided but not yet settled, kept so a retried settlement settles the same way. */
  decision: z
    .object({ reason: z.enum(["rejected", "unconfirmed", "withdrawn"]), message: z.string(), code: emailProviderFailureCodeSchema.optional() })
    .optional(),
})
export type DeliveryPayload = z.infer<typeof deliveryPayloadSchema>

export type DeliveryFailure = {
  reason: "rejected" | "unconfirmed" | "withdrawn"
  message: string
  code?: EmailProviderFailureCode
}

const resultSchema = z.object({
  outcome: z.enum(["delivered", "rejected", "unconfirmed", "withdrawn"]),
  message: z.string().nullable(),
  code: emailProviderFailureCodeSchema.optional(),
})
export type DeliveryResult = z.infer<typeof resultSchema>

export type DeliveryContext = {
  tx: Prisma.TransactionClient
  organizationId: string
  target: Record<string, string>
  commandId?: string
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
  recoveryOf?: string
  manualReason?: string
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
      requests: 0,
      ...(input.recoveryOf ? { recoveryOf: input.recoveryOf, manualReason: input.manualReason } : {}),
    }
    const key = deliveryKey(input.idempotencyKey)
    command.enqueue({ type: EMAIL_DELIVERY_JOB, payload, dedupeKey: key })
    return { deliveryKey: key }
  })

/**
 * Who may write a delivery's job: the run that holds its claim, or (for a job the runner gave up
 * on, which no run holds) the abandoned-delivery sweep. A run that stalled past its lease no longer
 * matches, so it can neither record progress nor settle the document.
 */
type JobFence = { id: string; organizationId: string; claimToken: string | null }

function fenced(job: JobFence) {
  return job.claimToken ? { id: job.id, claimToken: job.claimToken } : { id: job.id, claimToken: null, status: "failed" }
}

/** Provider messages are untrusted, including pinned decisions from older outbox jobs. */
function safeFailure(failure: DeliveryFailure): DeliveryFailure {
  if (failure.reason !== "rejected") return failure
  const code = failure.code ?? "email_provider_refused"
  return { ...failure, code, message: emailProviderFailureMessage(code) }
}

/**
 * Settles the document and records the outcome on the job, in one transaction. The job is
 * claimed first, so a delivery settles at most once and only by whoever holds it.
 */
async function settle(
  job: JobFence,
  payload: DeliveryPayload,
  completion: DeliveryCompletion,
  outcome: { delivered: true } | { delivered: false; failure: DeliveryFailure }
) {
  if (!outcome.delivered) outcome = { delivered: false, failure: safeFailure(outcome.failure) }
  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await lockArtifactOrganization(tx, job.organizationId)
    const result: DeliveryResult = outcome.delivered
      ? { outcome: "delivered", message: null }
      : { outcome: outcome.failure.reason, message: outcome.failure.message, ...(outcome.failure.code ? { code: outcome.failure.code } : {}) }
    const recorded = await tx.job.updateMany({
      where: { ...fenced(job), result: { equals: Prisma.DbNull } },
      data: { result, ...(payload.decision ? { payload: { ...payload, decision: safeFailure(payload.decision) } } : {}) },
    })
    if (recorded.count === 0) {
      throw new StaleJobClaimError(`Delivery job ${job.id} is no longer held by this run`)
    }
    const context = { tx, organizationId: job.organizationId, target: payload.completion.target, commandId: payload.commandId, now }
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
  })
}

const UNCONFIRMED_MESSAGE =
  "The email provider never confirmed delivery, so the customer may or may not have received it."

/** Updates the stored payload; only fields of this delivery's own bookkeeping change. */
async function recordOnJob(job: JobFence, payload: DeliveryPayload) {
  const { count } = await prisma.job.updateMany({ where: fenced(job), data: { payload } })
  if (count === 0) {
    throw new StaleJobClaimError(`Delivery job ${job.id} is no longer held by this run`)
  }
}

/**
 * Records the decided failure, then settles it. A withdrawal ends the job normally; a refused or
 * unconfirmed delivery is reported to the job runner as permanent, so it counts as failed.
 */
async function settleDecision(
  job: JobFence,
  payload: DeliveryPayload,
  completion: DeliveryCompletion,
  failure: DeliveryFailure
) {
  failure = safeFailure(failure)
  if (!payload.decision) {
    await recordOnJob(job, { ...payload, decision: failure })
  }
  await settle(job, payload, completion, { delivered: false, failure })
  if (failure.reason !== "withdrawn") {
    throw new TerminalJobError(`Email ${failure.reason}: ${failure.message}`)
  }
}

/**
 * Provider requests a delivery has started. Payloads written before requests were counted only
 * know how often the job ran, and any run may have reached the provider.
 */
function requestsStarted(payload: DeliveryPayload, jobAttempts: number) {
  return payload.requests ?? (jobAttempts > 0 ? 1 : 0)
}

const NOT_WAITING_MESSAGE = "The document no longer waited for this delivery"

/** What a delivery that can no longer settle its document is recorded as. */
const orphanedResult = (payload: DeliveryPayload, jobAttempts: number): DeliveryResult =>
  payload.providerMessageId
    ? { outcome: "delivered", message: null }
    : requestsStarted(payload, jobAttempts) > 0
      ? { outcome: "unconfirmed", message: NOT_WAITING_MESSAGE }
      : { outcome: "withdrawn", message: NOT_WAITING_MESSAGE }

registerJobHandler(EMAIL_DELIVERY_JOB, async (job) => {
  const payload = deliveryPayloadSchema.parse(job.payload)
  const completion = completions.get(payload.completion.kind)
  if (!completion) {
    throw new Error(`No delivery completion registered for ${payload.completion.kind}`)
  }
  if (!(await completion.pending(prisma, payload.completion.target))) {
    // Recorded so callers never wait on it; an outcome already recorded is kept.
    await prisma.job.updateMany({
      where: { ...fenced(job), result: { equals: Prisma.DbNull } },
      data: { result: orphanedResult(payload, job.attempts - 1) },
    })
    return
  }
  // Accepted by an earlier attempt whose settlement failed: settle without sending again.
  if (payload.providerMessageId) {
    await settle(job, payload, completion, { delivered: true })
    return
  }
  // Decided by an earlier attempt whose settlement failed: settle the same way.
  if (payload.decision) {
    return settleDecision(job, payload, completion, payload.decision)
  }

  // Every earlier request ended without an answer (an answer would have settled it), so any of
  // them may have been delivered.
  // This run's claim counts in job.attempts, so earlier runs are attempts - 1.
  const requests = requestsStarted(payload, job.attempts - 1)
  const possiblyDelivered = requests > 0
  // A runner may have stopped after starting an SMTP request. Even a stable Message-ID cannot
  // deduplicate SMTP, so another runner must settle it without making a second submission.
  if (possiblyDelivered && payload.provider === "smtp") {
    return settleDecision(job, payload, completion, { reason: "unconfirmed", message: UNCONFIRMED_MESSAGE })
  }
  if (possiblyDelivered && Date.now() - job.createdAt.getTime() >= IDEMPOTENCY_WINDOW_MS) {
    return settleDecision(job, payload, completion, { reason: "unconfirmed", message: UNCONFIRMED_MESSAGE })
  }
  const withdrawal = await completion.withdrawalReason?.(prisma, payload.completion.target)
  if (withdrawal) {
    return settleDecision(
      job,
      payload,
      completion,
      possiblyDelivered
        ? { reason: "unconfirmed", message: `${UNCONFIRMED_MESSAGE} Further attempts were stopped: ${withdrawal}` }
        : { reason: "withdrawn", message: withdrawal }
    )
  }

  // A process that cannot send at all makes no request; that is not an unknown outcome.
  let provider: "resend" | "smtp"
  try {
    provider = payload.provider ?? (possiblyDelivered ? "resend" : selectedEmailProvider())
    ensureEmailProvider(provider)
  } catch (error) {
    if (job.attempts >= EMAIL_DELIVERY_ATTEMPTS) {
      return settleDecision(
        job,
        payload,
        completion,
        possiblyDelivered
          ? { reason: "unconfirmed", message: UNCONFIRMED_MESSAGE }
          : { reason: "withdrawn", message: NOT_CONFIGURED_MESSAGE }
      )
    }
    throw error
  }

  // Counted before the request, so a request whose outcome is lost is never mistaken for none.
  const requested: DeliveryPayload = { ...payload, requests: requests + 1, provider,
    attempts: [...(payload.attempts ?? []), { startedAt: new Date().toISOString(), outcome: "started" }],
  }
  await recordOnJob(job, requested)
  // Checked again after the writes above, which can stall: no request once the key may have lapsed.
  if (possiblyDelivered && Date.now() - job.createdAt.getTime() >= IDEMPOTENCY_WINDOW_MS) {
    return settleDecision(job, requested, completion, { reason: "unconfirmed", message: UNCONFIRMED_MESSAGE })
  }
  let accepted: { id: string }
  try {
    accepted = await withTimeout(
      deliver(payload.message, { idempotencyKey: payload.idempotencyKey, provider }),
      PROVIDER_TIMEOUT_MS
    )
  } catch (error) {
    requested.attempts!.at(-1)!.outcome = isDefiniteRejection(error) ? "rejected" : "uncertain"
    await recordOnJob(job, requested)
    if (isDefiniteRejection(error)) {
      deliveryLogger.warn("email.rejected", { kind: payload.completion.kind, providerCode: error.providerCode })
      // Only this SMTP classification proves the connection failed before submission.
      // Timeouts and lost responses remain uncertain, never a definite refusal.
      const code = error.providerCode === "smtp_unavailable" ? "email_provider_unreachable" : "email_provider_refused"
      // A refusal proves only that this request delivered nothing.
      return settleDecision(
        job,
        requested,
        completion,
        possiblyDelivered
          ? { reason: "unconfirmed", message: UNCONFIRMED_MESSAGE }
          : { reason: "rejected", code, message: emailProviderFailureMessage(code) }
      )
    }
    if (provider === "smtp" || job.attempts >= EMAIL_DELIVERY_ATTEMPTS) {
      deliveryLogger.error("email.unconfirmed", { kind: payload.completion.kind, error })
      return settleDecision(job, requested, completion, { reason: "unconfirmed", message: UNCONFIRMED_MESSAGE })
    }
    // Retried with backoff by the job runner, replaying the same message and key.
    throw error
  }

  // Recorded first, so a settlement that fails is retried without sending again.
  requested.attempts!.at(-1)!.outcome = "accepted"
  requested.attempts!.at(-1)!.providerMessageId = accepted.id
  await recordOnJob(job, { ...requested, providerMessageId: accepted.id })
  await settle(job, payload, completion, { delivered: true })
})

/**
 * Settles deliveries whose job ended without settling: a runner that stopped on the last allowed
 * attempt, or a settlement that kept failing. An accepted message settles as delivered and a
 * decided failure as decided; otherwise a delivery that made a request may have been delivered
 * (unconfirmed), and one that never made a request delivered nothing. Runs on every scheduler tick.
 */
export async function settleAbandonedDeliveries(input: { organizationIds?: readonly string[]; limit?: number } = {}) {
  const abandoned = await prisma.job.findMany({
    where: {
      type: EMAIL_DELIVERY_JOB,
      status: "failed",
      claimToken: null,
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
      const payload = deliveryPayloadSchema.parse(job.payload)
      const completion = completions.get(payload.completion.kind)
      if (!completion) throw new Error(`No delivery completion registered for ${payload.completion.kind}`)
      if (!(await completion.pending(prisma, payload.completion.target))) {
        // Nothing left to settle; recorded so the sweep does not look at this job again.
        await prisma.job.updateMany({
          where: { ...fenced(job), result: { equals: Prisma.DbNull } },
          data: { result: orphanedResult(payload, job.attempts) },
        })
        continue
      }
      await settle(
        job,
        payload,
        completion,
        payload.providerMessageId
          ? { delivered: true }
          : {
              delivered: false,
              failure:
                payload.decision ??
                (requestsStarted(payload, job.attempts) > 0
                  ? { reason: "unconfirmed", message: UNCONFIRMED_MESSAGE }
                  : { reason: "withdrawn", message: NEVER_SENT_MESSAGE }),
            }
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

registerDeliveryCompletion("agreement.notification", {
  pending: async () => true,
  delivered: async () => [],
  failed: async () => [],
})

/** Used by operator recovery after authorization. The original completion is reused. */
export function getDeliveryCompletion(kind: string) { return completions.get(kind) }
