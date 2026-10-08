import { Effect } from "effect"
import { createHash } from "node:crypto"
import { z } from "zod"
import type {
  JournalDocumentInput,
  JournalDeliveryInput,
  JournalManualResendInput,
  JournalStepState
} from "@quits/contracts/journal"
import { journalManualResendInputSchema } from "@quits/contracts/journal"
import { Prisma } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"
import { createEmailDeliveryAttempt } from "../../lib/email-delivery"
import { ensureEmailProvider } from "../../lib/email"
import { getEmailDeliveryStatusProvider } from "../../lib/runtime/services"
import { actorCan, type Actor } from "../actor"
import { defineCommand } from "../command"
import { lockArtifactOrganization } from "../documents/artifacts"
import { lockDocument } from "../documents/locks"
import { ManualEmailReplacement } from "../documents/document-delivery"
import { resendInvoiceEmail } from "../commands/invoices"
import { resendQuoteEmail } from "../commands/quotes"
import { resendAgreement } from "../commands/agreement-lifecycle"
import { appendEvents } from "../events"
import { Forbidden, InvalidState, NotFound } from "../errors"
import { runJobsNow } from "../jobs"
import type { Permission } from "../permissions"
import { Command, Db } from "../services"
import { aggregateTypeAliases } from "../../lib/exports/activity"
import {
  deliveryPayloadSchema,
  EMAIL_DELIVERY_ATTEMPTS,
  EMAIL_DELIVERY_JOB,
  enqueueEmailDelivery,
  getDeliveryCompletion,
  IDEMPOTENCY_WINDOW_MS,
  type DeliveryPayload
} from "./outbox"

function deliveryAvailable() {
  try {
    ensureEmailProvider()
    return true
  } catch {
    return false
  }
}

const lookupEvidenceSchema = z
  .object({
    evidenceId: z.string().trim().min(1).max(1000),
    observedAt: z.date(),
    outcome: z.enum(["accepted", "unknown"]),
    providerMessageId: z.string().trim().min(1).max(1000).optional()
  })
  .refine(
    (evidence) =>
      evidence.outcome !== "accepted" || Boolean(evidence.providerMessageId),
    {
      message: "Acceptance evidence requires a provider message ID"
    }
  )

const permissions = {
  invoice: { read: "invoice:read", send: "invoice:send" },
  quote: { read: "quote:read", send: "quote:send" },
  creditNote: { read: "creditNote:read", send: "creditNote:send" },
  agreement: { read: "agreement:read", send: "agreement:send" }
} as const satisfies Record<
  JournalDocumentInput["documentType"],
  { read: Permission; send: Permission }
>

/** Always check permission and record membership before reading jobs or receipts. */
export async function journalDocument(
  actor: Actor,
  input: JournalDocumentInput,
  send = false,
  db: Prisma.TransactionClient = prisma
) {
  for (const permission of [
    permissions[input.documentType].read,
    ...(send ? [permissions[input.documentType].send] : [])
  ]) {
    if (!actorCan(actor, permission))
      throw new Forbidden({
        message: "Your role cannot access this operation",
        permission
      })
  }
  const where = { id: input.documentId, organizationId: actor.organizationId }
  const select = {
    id: true,
    contactId: true,
    number: true,
    status: true,
    updatedAt: true,
    contact: { select: { email: true, updatedAt: true } },
    lastEmailAttemptAt: true,
    lastEmailAttemptOutcome: true
  }
  const document =
    input.documentType === "invoice"
      ? await db.invoice.findFirst({
          where,
          select: { ...select, publicPaymentKeyVersion: true }
        })
      : input.documentType === "quote"
        ? await db.quote.findFirst({
            where,
            select: { ...select, publicAccessKeyVersion: true }
          })
        : input.documentType === "creditNote"
          ? await db.creditNote.findFirst({ where, select })
          : await db.agreement.findFirst({
              where,
              select: {
                ...select,
                publicAccessKeyVersion: true,
                issuedToEmail: true
              }
            })
  if (!document)
    throw new NotFound({
      message: "Document not found",
      entity: input.documentType
    })
  return document
}

function jobDocumentFilter(input: JournalDocumentInput): Prisma.JobWhereInput {
  // Target IDs alone do not authorize a different kind of document.
  const targetKey =
    input.documentType === "invoice"
      ? "invoiceId"
      : input.documentType === "agreement"
        ? "agreementId"
        : "documentId"
  return {
    OR: [
      {
        AND: [
          {
            payload: {
              path: ["completion", "kind"],
              string_starts_with: `${input.documentType}.`
            }
          },
          {
            payload: {
              path: ["completion", "target", "documentId"],
              equals: input.documentId
            }
          }
        ]
      },
      ...(input.documentType === "invoice" || input.documentType === "agreement"
        ? [
            {
              AND: [
                {
                  payload: {
                    path: ["completion", "kind"],
                    equals:
                      input.documentType === "invoice"
                        ? "reminder"
                        : "agreement.notification"
                  }
                },
                {
                  payload: {
                    path: ["completion", "target", targetKey],
                    equals: input.documentId
                  }
                }
              ]
            }
          ]
        : [])
    ]
  }
}

async function scopedJob(
  actor: Actor,
  input: JournalDeliveryInput,
  db: Prisma.TransactionClient = prisma
) {
  const job = await db.job.findFirst({
    where: {
      id: input.deliveryId,
      organizationId: actor.organizationId,
      type: EMAIL_DELIVERY_JOB,
      ...jobDocumentFilter(input)
    }
  })
  if (!job)
    throw new NotFound({ message: "Delivery not found", entity: "delivery" })
  return { job, payload: deliveryPayloadSchema.parse(job.payload) }
}

type DeliveryRow = Awaited<ReturnType<typeof scopedJob>>["job"]
const resultOutcome = (job: DeliveryRow) =>
  job.result && typeof job.result === "object" && !Array.isArray(job.result)
    ? job.result.outcome
    : null
const requestsStarted = (job: DeliveryRow, payload: DeliveryPayload) =>
  payload.requests ?? (job.attempts > 0 ? 1 : 0)

/** Recovery only re-runs the original fenced completion or a safe original-key submission. */
function canRecover(job: DeliveryRow, payload: DeliveryPayload) {
  if (job.result !== null || job.status === "running" || job.claimToken)
    return false
  if (payload.providerMessageId || payload.decision) return true
  if (requestsStarted(job, payload) === 0) return true
  return (
    payload.provider !== "smtp" &&
    job.attempts < EMAIL_DELIVERY_ATTEMPTS &&
    Date.now() - job.createdAt.getTime() < IDEMPOTENCY_WINDOW_MS
  )
}

function linkVersion(document: Awaited<ReturnType<typeof journalDocument>>) {
  return "publicAccessKeyVersion" in document
    ? String(document.publicAccessKeyVersion)
    : "publicPaymentKeyVersion" in document
      ? String(document.publicPaymentKeyVersion)
      : null
}

function reviewedTarget(
  document: Awaited<ReturnType<typeof journalDocument>>,
  recipient: string
) {
  return {
    revision: createHash("sha256")
      .update(JSON.stringify(document))
      .digest("hex"),
    recipient,
    publicLinkKeyVersion: linkVersion(document)
  }
}

function currentRecipient(
  document: Awaited<ReturnType<typeof journalDocument>>
) {
  return "issuedToEmail" in document
    ? typeof document.issuedToEmail === "string"
      ? document.issuedToEmail.trim()
      : null
    : (document.contact.email?.trim() ?? null)
}

function manualEligible(
  document: Awaited<ReturnType<typeof journalDocument>>,
  job: DeliveryRow,
  payload: DeliveryPayload,
  input: JournalDocumentInput,
  mode: "stored" | "replacement" = "stored"
) {
  const version =
    "publicAccessKeyVersion" in document
      ? document.publicAccessKeyVersion
      : "publicPaymentKeyVersion" in document
        ? document.publicPaymentKeyVersion
        : null
  // Legacy deliveries omitted the key version. After a revocation, their old link cannot
  // be proven usable, so the documented current-document workflow is required instead.
  const linkStillValid =
    version === null ||
    (payload.completion.target.publicLinkKeyVersion
      ? String(version) === payload.completion.target.publicLinkKeyVersion
      : version === 1)
  return (
    (mode === "stored"
      ? linkStillValid
      : !linkStillValid && Boolean(currentRecipient(document))) &&
    resultOutcome(job) === "unconfirmed" &&
    !payload.providerMessageId &&
    /\.(send|email)$/.test(payload.completion.kind) &&
    document.lastEmailAttemptOutcome === "unconfirmed" &&
    document.lastEmailAttemptAt?.toISOString() ===
      payload.completion.target.attemptAt &&
    (input.documentType !== "invoice" ||
      ["sent", "overdue"].includes(document.status)) &&
    (input.documentType !== "quote" ||
      ["sent", "accepted", "rejected"].includes(document.status)) &&
    (input.documentType !== "agreement" ||
      ["sent", "accepted"].includes(document.status))
  )
}

function deliveryState(
  job: DeliveryRow,
  payload: DeliveryPayload
): JournalStepState {
  const outcome = resultOutcome(job)
  if (outcome === "delivered" || payload.providerMessageId)
    return "delivery_confirmed"
  if (outcome === "unconfirmed" || payload.decision?.reason === "unconfirmed")
    return "uncertain"
  if (outcome === "withdrawn" || payload.decision?.reason === "withdrawn")
    return "waiting_prerequisite"
  if (outcome === "rejected" || payload.decision?.reason === "rejected")
    return "failed_step"
  if (requestsStarted(job, payload) > 0 && !outcome) return "uncertain"
  if (!outcome && requestsStarted(job, payload) === 0 && !deliveryAvailable())
    return "waiting_prerequisite"
  if (job.status === "failed") return "failed_step"
  return "queued"
}

const commandBlockers = [
  "email_unavailable",
  "missing_recipient",
  "provider_missing",
  "send_in_progress",
  "manual_resend_required",
  "compliance_failed",
  "not_sent",
  "not_draft"
] as const
function commandBlocker(error: Prisma.JsonValue) {
  if (!error || typeof error !== "object" || Array.isArray(error)) return null
  return commandBlockers.find((code) => code === error.code) ?? null
}

export async function documentJournal(
  actor: Actor,
  input: JournalDocumentInput
) {
  const document = await journalDocument(actor, input)
  const organizationId = actor.organizationId
  const [events, jobs, approvals] = await Promise.all([
    prisma.domainEvent.findMany({
      where: {
        organizationId,
        aggregateType: { in: aggregateTypeAliases(input.documentType) },
        aggregateId: input.documentId
      },
      orderBy: { sequence: "desc" },
      take: 200
    }),
    prisma.job.findMany({
      where: {
        organizationId,
        type: EMAIL_DELIVERY_JOB,
        ...jobDocumentFilter(input)
      },
      orderBy: { createdAt: "desc" },
      take: 100
    }),
    prisma.approvalRequest.findMany({
      where: {
        organizationId,
        commandType: {
          startsWith: `${input.documentType === "creditNote" ? "credit_note" : input.documentType}.`
        },
        command: { path: ["id"], equals: input.documentId }
      },
      select: { commandReceiptId: true },
      take: 100
    })
  ])
  const payloads = jobs.map((job) => deliveryPayloadSchema.parse(job.payload))
  const commandIds = [
    ...new Set([
      ...events.flatMap((event) => (event.commandId ? [event.commandId] : [])),
      ...payloads.map((payload) => payload.commandId),
      ...approvals.map((approval) => approval.commandReceiptId)
    ])
  ]
  const receipts = await prisma.commandReceipt.findMany({
    where: {
      organizationId,
      OR: [
        { id: { in: commandIds } },
        {
          AND: [
            { target: { path: ["documentType"], equals: input.documentType } },
            { target: { path: ["documentId"], equals: input.documentId } }
          ]
        }
      ]
    },
    orderBy: { createdAt: "desc" },
    take: 100
  })
  const canSend =
    actor.kind === "user" &&
    actorCan(actor, permissions[input.documentType].send)
  const provider = getEmailDeliveryStatusProvider()
  return {
    document: {
      id: document.id,
      number: document.number,
      type: input.documentType
    },
    truncated:
      events.length === 200 ||
      jobs.length === 100 ||
      approvals.length === 100 ||
      receipts.length === 100,
    commands: receipts.map((receipt) => ({
      id: receipt.id,
      type: receipt.commandType,
      at: receipt.createdAt.toISOString(),
      blocker: commandBlocker(receipt.error),
      awaitingApproval: receipt.status === "awaiting_approval",
      state: (receipt.status === "completed"
        ? "effects_completed"
        : receipt.status === "awaiting_approval" ||
            [
              "email_unavailable",
              "missing_recipient",
              "provider_missing",
              "send_in_progress"
            ].includes(commandBlocker(receipt.error) ?? "")
          ? "waiting_prerequisite"
          : "failed_step") as JournalStepState,
      steps: events
        .filter((event) => event.commandId === receipt.id)
        .map((event) => ({
          type: event.type,
          at: event.occurredAt.toISOString()
        }))
    })),
    // Older data without receipts still has visible completed effects.
    effects: events.map((event) => ({
      type: event.type,
      at: event.occurredAt.toISOString(),
      commandId: event.commandId
    })),
    deliveries: jobs.map((job, index) => {
      const payload = payloads[index]!
      return {
        id: job.id,
        commandId: payload.commandId,
        queuedAt: job.createdAt.toISOString(),
        recipient: payload.message.to,
        state: deliveryState(job, payload),
        settlementPending: Boolean(payload.providerMessageId && !job.result),
        provider: payload.provider ?? null,
        providerReference: payload.providerMessageId ?? null,
        attempts: payload.attempts ?? [],
        legacyAttempts: payload.attempts ? 0 : job.attempts,
        evidence: payload.evidence ?? [],
        recoveryOf: payload.recoveryOf ?? null,
        manualReason: payload.manualReason ?? null,
        manualMode: payload.manualReview?.mode ?? null,
        canRecover: canSend && canRecover(job, payload),
        canReconcile:
          canSend &&
          !job.claimToken &&
          job.status !== "running" &&
          requestsStarted(job, payload) > 0 &&
          resultOutcome(job) !== "delivered" &&
          Boolean(provider?.supports(payload.provider ?? "resend")),
        canManualResend:
          canSend &&
          manualEligible(document, job, payload, input) &&
          !payloads.some((other) => other.recoveryOf === job.id),
        manualTarget: reviewedTarget(document, payload.message.to),
        canReplaceEmail:
          canSend &&
          manualEligible(document, job, payload, input, "replacement") &&
          !payloads.some((other) => other.recoveryOf === job.id),
        replacementTarget: currentRecipient(document)
          ? reviewedTarget(document, currentRecipient(document)!)
          : null,
        // Provider failures may contain sensitive response data; show only the settled safe explanation.
        failure:
          resultOutcome(job) === "rejected"
            ? "rejected"
            : resultOutcome(job) === "withdrawn"
              ? "withdrawn"
              : null
      }
    })
  }
}

export async function recoverDelivery(
  actor: Actor,
  input: JournalDeliveryInput
) {
  if (actor.kind !== "user")
    throw new Forbidden({ message: "Recovery requires an authorized person" })
  await prisma.$transaction(async (tx) => {
    await lockArtifactOrganization(tx, actor.organizationId)
    await journalDocument(actor, input, true, tx)
    const { job, payload } = await scopedJob(actor, input, tx)
    if (!canRecover(job, payload))
      throw new InvalidState({
        message:
          "This delivery cannot be retried safely. Verify an uncertain delivery before choosing the manual path.",
        code: "unsafe_retry"
      })
    const recovered = await tx.job.updateMany({
      where: {
        id: job.id,
        status: job.status,
        claimToken: null,
        payload: { equals: job.payload as Prisma.InputJsonValue }
      },
      data: {
        status: "pending",
        runAfter: new Date(),
        // Only never-submitted work gets a fresh budget. External request counts never reset.
        ...(requestsStarted(job, payload) === 0 ? { attempts: 0 } : {})
      }
    })
    if (!recovered.count)
      throw new InvalidState({
        message: "Delivery changed. Refresh and try again.",
        code: "delivery_changed"
      })
    await appendEvents(tx, {
      organizationId: actor.organizationId,
      actor,
      commandId: payload.commandId,
      approvedByUserId: null,
      occurredAt: new Date(),
      events: [
        {
          aggregateType:
            input.documentType === "creditNote"
              ? "credit_note"
              : input.documentType,
          aggregateId: input.documentId,
          type: "delivery.recovery_requested",
          payload: { deliveryId: job.id }
        }
      ]
    })
  })
  await runJobsNow([input.deliveryId])
  return documentJournal(actor, input)
}

/** The lookup happens outside a transaction, then evidence is applied under the same organization
 * lock as settlement. Runners are never unfenced; late or repeated evidence cannot regress acceptance.
 */
export async function reconcileDelivery(
  actor: Actor,
  input: JournalDeliveryInput
) {
  if (actor.kind !== "user")
    throw new Forbidden({
      message: "Reconciliation requires an authorized person"
    })
  await journalDocument(actor, input, true)
  const original = await scopedJob(actor, input)
  const provider = getEmailDeliveryStatusProvider()
  const pinned = original.payload.provider ?? "resend"
  if (!provider?.supports(pinned))
    throw new InvalidState({
      message:
        "No trustworthy provider lookup is available. Verify delivery with the recipient or provider before deciding whether to resend.",
      code: "lookup_unavailable"
    })
  if (requestsStarted(original.job, original.payload) === 0)
    throw new InvalidState({
      message: "No provider request was made",
      code: "not_submitted"
    })
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            "Provider lookup did not answer. Delivery remains unresolved."
          )
        ),
      15_000
    )
  })
  const lookedUp = await Promise.race([
    Promise.resolve().then(() =>
      provider.lookup({
        organizationId: actor.organizationId,
        provider: pinned,
        idempotencyKey: original.payload.idempotencyKey,
        providerMessageId: original.payload.providerMessageId
      })
    ),
    deadline
  ]).finally(() => clearTimeout(timer))
  const evidence = lookupEvidenceSchema.parse(lookedUp)
  await prisma.$transaction(async (tx) => {
    await lockArtifactOrganization(tx, actor.organizationId)
    await journalDocument(actor, input, true, tx)
    const { job, payload } = await scopedJob(actor, input, tx)
    if (
      payload.evidence?.some(
        (item) => item.evidenceId === evidence.evidenceId
      ) ||
      payload.providerMessageId ||
      resultOutcome(job) === "delivered"
    )
      return
    if (job.claimToken || job.status === "running")
      throw new InvalidState({
        message: "A delivery is running. Refresh after it finishes.",
        code: "delivery_running"
      })
    const storedEvidence = {
      ...evidence,
      observedAt: evidence.observedAt.toISOString()
    }
    const updated = {
      ...payload,
      evidence: [...(payload.evidence ?? []), storedEvidence],
      ...(evidence.outcome === "accepted"
        ? { providerMessageId: evidence.providerMessageId }
        : {})
    }
    const applied = await tx.job.updateMany({
      where: {
        id: job.id,
        status: job.status,
        claimToken: null,
        payload: { equals: job.payload as Prisma.InputJsonValue }
      },
      data: {
        payload: updated,
        ...(evidence.outcome === "accepted"
          ? {
              result: { outcome: "delivered", message: null },
              status: "done",
              lastError: null
            }
          : {})
      }
    })
    if (!applied.count)
      throw new InvalidState({
        message: "Delivery changed during lookup. Refresh and try again.",
        code: "delivery_changed"
      })
    const completion = getDeliveryCompletion(payload.completion.kind)
    if (
      evidence.outcome === "accepted" &&
      completion &&
      (await completion.pending(tx, payload.completion.target))
    ) {
      const events = await completion.delivered({
        tx,
        organizationId: actor.organizationId,
        target: payload.completion.target,
        commandId: payload.commandId,
        now: new Date()
      })
      await appendEvents(tx, {
        organizationId: actor.organizationId,
        actor: payload.actor,
        commandId: payload.commandId,
        approvedByUserId: payload.approvedByUserId,
        occurredAt: new Date(),
        events
      })
    } else if (
      evidence.outcome === "accepted" &&
      /\.(send|email)$/.test(payload.completion.kind)
    ) {
      // An uncertain delivery already issued its record. Confirm only the matching marker,
      // retaining its financial events and any more recent delivery's state.
      const where = {
        id: input.documentId,
        organizationId: actor.organizationId,
        lastEmailAttemptOutcome: "unconfirmed",
        lastEmailAttemptAt: new Date(payload.completion.target.attemptAt)
      }
      const data = createEmailDeliveryAttempt({
        at: where.lastEmailAttemptAt,
        outcome: "sent",
        code: "provider_confirmed",
        message: "The provider confirmed acceptance of this email."
      })
      if (input.documentType === "invoice")
        await tx.invoice.updateMany({ where, data })
      else if (input.documentType === "quote")
        await tx.quote.updateMany({ where, data })
      else if (input.documentType === "creditNote")
        await tx.creditNote.updateMany({ where, data })
      else await tx.agreement.updateMany({ where, data })
    }
    await appendEvents(tx, {
      organizationId: actor.organizationId,
      actor,
      commandId: payload.commandId,
      approvedByUserId: null,
      occurredAt: new Date(),
      events: [
        {
          aggregateType:
            input.documentType === "creditNote"
              ? "credit_note"
              : input.documentType,
          aggregateId: input.documentId,
          type: "delivery.provider_evidence",
          payload: { deliveryId: job.id, ...storedEvidence }
        }
      ]
    })
  })
  return documentJournal(actor, input)
}

/** This human-only command queues a new communication for the same issued record. It never
 * calls the creation/issuance command or replays financial effects. One manual recovery per source.
 */
export function manualResendCommand(
  documentType: JournalDocumentInput["documentType"]
) {
  return defineCommand({
    type: "delivery.manual_resend",
    permission: permissions[documentType].send,
    outwardFacing: true,
    input: journalManualResendInputSchema,
    summarize: (input: JournalManualResendInput) =>
      `Manually resend ${input.documentType} ${input.documentId} after an uncertain delivery`,
    handle: (input) =>
      Effect.gen(function* () {
        const db = yield* Db
        const command = yield* Command
        if (
          command.actor.kind !== "user" ||
          input.documentType !== documentType
        )
          return yield* new Forbidden({
            message: "Manual recovery requires an authorized person"
          })
        yield* lockDocument(documentType, input.documentId)
        const document = yield* Effect.tryPromise({
          try: () => journalDocument(command.actor, input, true, db),
          catch: (error) => error as Forbidden | NotFound
        })
        // Contact edits do not necessarily update the document. Lock and re-read it as part
        // of the reviewed target, so a changed recipient cannot slip into the queued message.
        yield* lockDocument("contact", document.contactId, {
          strength: "no_key_update"
        })
        const current = yield* Effect.tryPromise({
          try: () => journalDocument(command.actor, input, true, db),
          catch: (error) => error as Forbidden | NotFound
        })
        const { job, payload } = yield* Effect.tryPromise({
          try: () => scopedJob(command.actor, input, db),
          catch: (error) => error as NotFound
        })
        const previous = yield* Effect.promise(() =>
          db.job.count({
            where: {
              organizationId: command.organizationId,
              type: EMAIL_DELIVERY_JOB,
              payload: { path: ["recoveryOf"], equals: job.id }
            }
          })
        )
        if (
          !manualEligible(current, job, payload, input, input.mode) ||
          previous > 0
        )
          return yield* new InvalidState({
            message:
              "This delivery is no longer eligible for manual resend. Refresh the operation history.",
            code: "manual_resend_unavailable"
          })
        const recipient =
          input.mode === "replacement"
            ? currentRecipient(current)!
            : payload.message.to
        const target = reviewedTarget(current, recipient)
        if (
          input.reviewedTarget.revision !== target.revision ||
          input.reviewedTarget.recipient !== target.recipient ||
          input.reviewedTarget.publicLinkKeyVersion !==
            target.publicLinkKeyVersion
        )
          return yield* new InvalidState({
            message:
              "The reviewed document, recipient or public link changed. Refresh the operation history and verify the new target.",
            code: "delivery_changed"
          })
        if (!deliveryAvailable())
          return yield* new InvalidState({
            message: "Configure email delivery before resending",
            code: "email_unavailable"
          })
        if (input.mode === "replacement") {
          // Reuse the issued-document send checks and current rendering, never issuance.
          command.emit({
            aggregateType:
              documentType === "creditNote" ? "credit_note" : documentType,
            aggregateId: current.id,
            type: "delivery.manual_resend_requested",
            payload: {
              deliveryId: job.id,
              reason: input.reason,
              acknowledgeDuplicateRisk: true,
              recipient
            }
          })
          const send =
            documentType === "invoice"
              ? resendInvoiceEmail
                  .handle({ id: current.id })
                  .pipe(Effect.map(({ deliveryKey }) => ({ deliveryKey })))
              : documentType === "quote"
                ? resendQuoteEmail
                    .handle({ id: current.id })
                    .pipe(Effect.map(({ deliveryKey }) => ({ deliveryKey })))
                : resendAgreement
                    .handle({ id: current.id })
                    .pipe(Effect.map(({ deliveryKey }) => ({ deliveryKey })))
          const result = yield* send.pipe(
            Effect.provideService(ManualEmailReplacement, {
              kind: documentType,
              documentId: current.id,
              recipient,
              recoveryOf: job.id,
              reason: input.reason,
              review: { mode: input.mode, ...target }
            })
          )
          return { deliveryKey: result.deliveryKey }
        }
        const attempt = createEmailDeliveryAttempt({
          at: command.now,
          outcome: "sending",
          code: "sending",
          message: "Sending an explicitly requested manual resend."
        })
        const where = {
          id: document.id,
          organizationId: command.organizationId
        }
        yield* Effect.promise(async () => {
          if (documentType === "invoice")
            await db.invoice.updateMany({ where, data: attempt })
          else if (documentType === "quote")
            await db.quote.updateMany({ where, data: attempt })
          else if (documentType === "creditNote")
            await db.creditNote.updateMany({ where, data: attempt })
          else await db.agreement.updateMany({ where, data: attempt })
        })
        command.emit({
          aggregateType:
            documentType === "creditNote" ? "credit_note" : documentType,
          aggregateId: document.id,
          type: "delivery.manual_resend_requested",
          payload: {
            deliveryId: job.id,
            reason: input.reason,
            acknowledgeDuplicateRisk: true,
            recipient: payload.message.to
          }
        })
        return yield* enqueueEmailDelivery({
          message: payload.message,
          idempotencyKey: `manual-recovery:${command.commandId}`,
          recoveryOf: job.id,
          manualReason: input.reason,
          manualReview: { mode: input.mode, ...target },
          completion: {
            kind: `${documentType}.email`,
            target: {
              documentId: document.id,
              attemptAt: command.now.toISOString(),
              number: document.number ?? "",
              recipient: payload.message.to,
              ...(target.publicLinkKeyVersion
                ? { publicLinkKeyVersion: target.publicLinkKeyVersion }
                : {})
            }
          }
        })
      })
  })
}
