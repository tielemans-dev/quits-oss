import { createHash, randomUUID } from "node:crypto"
import { Cause, Effect, Exit, Option } from "effect"
import type { CommandError, CommandRecord } from "@quits/contracts/agent"
import { Prisma } from "../../generated/prisma/client"
import { prisma } from "../lib/db"
import { acquireBoundedAdvisoryLock } from "../lib/transaction-timeouts"
import { appLogger } from "../lib/observability"
import { actorCan, actorId, actorKey, type Actor } from "./actor"
import type { ApprovalContext, CommandDefinition } from "./command"
import {
  Forbidden,
  InvalidState,
  NotFound,
  ValidationFailed,
  serializeDomainError,
  type DomainError,
} from "./errors"
import { appendEvents } from "./events"
import { deserializeResult, serializeResult } from "./serialization"
import { runJobsNow } from "./jobs"
import { lockArtifactOrganization, bindIssuanceCandidate, publishCandidate } from "./documents/artifacts"
import { prospectiveRenderInput, type ArtifactDocumentKind, type RenderInput } from "./documents/render-input"
import { lockDocument } from "./documents/locks"
import { NUMBER_CHANGED } from "./documents/numbering"
import { Command, Db, type PendingEvent, type PendingJob } from "./services"

const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Long enough for large batch commands. Commands never call providers; email goes through the outbox. */
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 }
const domainLogger = appLogger.child("domain")

export type ExecuteOptions = {
  actor: Actor
  /** Caller-chosen idempotency key. Retrying with the same key returns the first outcome. */
  clientRequestId?: string
  /** Set when a human approved a queued agent command. */
  approvedByUserId?: string
  /** Receipt created when the command was queued for approval. */
  resumeReceiptId?: string
  /** The approval context version a person reviewed; the command is refused if it changed. */
  expectedApprovalVersion?: string
  now?: Date
  /** Application orchestration runs this after authorization, receipt lookup and approval gating. */
  prepareIssuance?: (input: unknown, now: Date) => Promise<string>
  issuanceStagingId?: string
}

export type CommandOutcome<Result> =
  | { status: "completed"; commandId: string; result: Result }
  | { status: "awaiting_approval"; commandId: string; approvalRequestId: string }
  | { status: "failed" | "rejected" | "expired"; commandId: string; error: CommandError }

/** Internal signal used to roll back the transaction when the handler fails. */
/** Another call with the same client request id already committed while this one waited. */
class AlreadyRecorded extends Error {}

class HandlerFailed extends Error {
  constructor(readonly domainError: DomainError) {
    super(domainError.message)
  }
}

export function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue
}

type FailedOutcome = { status: "failed"; commandId: string; error: CommandError }

function failure(commandId: string, error: DomainError): FailedOutcome {
  return { status: "failed", commandId, error: serializeDomainError(error) }
}

async function loadReceiptOutcome<Result>(
  organizationId: string,
  key: string,
  clientRequestId: string
): Promise<CommandOutcome<Result> | null> {
  const receipt = await prisma.commandReceipt.findUnique({
    where: {
      organizationId_actorKey_clientRequestId: {
        organizationId,
        actorKey: key,
        clientRequestId,
      },
    },
  })

  return receipt ? receiptToOutcome<Result>(receipt) : null
}

export async function receiptToOutcome<Result>(receipt: {
  id: string
  status: string
  result: Prisma.JsonValue
  error: Prisma.JsonValue
}): Promise<CommandOutcome<Result>> {
  if (receipt.status === "completed") {
    return {
      status: "completed",
      commandId: receipt.id,
      result: deserializeResult<Result>(receipt.result),
    }
  }

  if (receipt.status === "awaiting_approval") {
    const approval = await prisma.approvalRequest.findUnique({
      where: { commandReceiptId: receipt.id },
      select: { id: true },
    })
    return {
      status: "awaiting_approval",
      commandId: receipt.id,
      approvalRequestId: approval?.id ?? "",
    }
  }

  return {
    status: receipt.status === "rejected" || receipt.status === "expired" ? receipt.status : "failed",
    commandId: receipt.id,
    error: (receipt.error as CommandError | null) ?? {
      tag: "Unknown",
      message: `Command ${receipt.status}`,
    },
  }
}

export function toCommandRecord(
  commandType: string,
  outcome: CommandOutcome<unknown>
): CommandRecord {
  return {
    commandId: outcome.commandId,
    commandType,
    status: outcome.status,
    result: outcome.status === "completed" ? (outcome.result ?? null) : null,
    error:
      outcome.status === "completed" || outcome.status === "awaiting_approval" ? null : outcome.error,
    approvalRequestId: outcome.status === "awaiting_approval" ? outcome.approvalRequestId : null,
  }
}

/**
 * The single entry point for state changes. UI, agents, the scheduler, and webhooks all run
 * commands through here so authorization, idempotency, approval gating, auditing, and the job
 * outbox behave the same for every caller.
 */
export async function executeCommand<Input, Result>(
  definition: CommandDefinition<Input, Result>,
  rawInput: unknown,
  options: ExecuteOptions
): Promise<CommandOutcome<Result>> {
  const { actor } = options
  const organizationId = actor.organizationId
  const now = options.now ?? new Date()
  const key = actorKey(actor)
  const clientRequestId = options.clientRequestId

  if (!options.resumeReceiptId && clientRequestId) {
    const existing = await loadReceiptOutcome<Result>(organizationId, key, clientRequestId)
    if (existing) {
      return existing
    }
  }

  // With a client request id the command id is stable across retries, so anything keyed by it
  // (such as email idempotency keys) recognizes a retry of a rolled-back attempt.
  const provisionalId =
    options.resumeReceiptId ??
    (clientRequestId
      ? `cmd_${createHash("sha256").update(`${organizationId}\u0000${key}\u0000${clientRequestId}`).digest("hex").slice(0, 32)}`
      : `cmd_${randomUUID().replaceAll("-", "")}`)

  // A resumed (approved) command already has a receipt; failures before the handler runs must
  // still finalize it, or it would stay "awaiting approval" forever.
  const rejectEarly = async (error: DomainError) => {
    const outcome = failure(provisionalId, error)
    if (options.resumeReceiptId) {
      await recordFailedReceipt<Result>(definition.type, outcome, {
        organizationId,
        key,
        clientRequestId,
        resumeReceiptId: options.resumeReceiptId,
        transient: false,
      })
    }
    return outcome
  }

  if (actor.kind === "agent" && actor.mode === "read_only") {
    return rejectEarly(
      new Forbidden({ message: "This agent key is read-only", permission: definition.permission })
    )
  }

  if (!actorCan(actor, definition.permission)) {
    return rejectEarly(
      new Forbidden({
        message: `Missing permission ${definition.permission}`,
        permission: definition.permission,
      })
    )
  }

  const parsed = definition.input.safeParse(rawInput)
  if (!parsed.success) {
    return rejectEarly(
      new ValidationFailed({
        message: "Invalid command input",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      })
    )
  }
  const input = parsed.data

  let needsApproval =
    actor.kind === "agent" &&
    actor.mode === "approval_required" &&
    definition.outwardFacing &&
    !options.approvedByUserId

  if (needsApproval && definition.requiresApproval) {
    const decided = await readInScope(definition.requiresApproval(input), {
      actor,
      organizationId,
      commandId: provisionalId,
      now,
    })
    if (decided.kind === "failed") {
      return rejectEarly(decided.error)
    }
    needsApproval = decided.value
  }

  if (needsApproval && actor.kind === "agent") {
    return queueForApproval(definition, input, {
      actor,
      organizationId,
      key,
      clientRequestId: clientRequestId ?? provisionalId,
      commandId: provisionalId,
      now,
    })
  }

  let issuanceStagingId = options.issuanceStagingId
  try {
    if (options.prepareIssuance) issuanceStagingId = await options.prepareIssuance(input, now)
  } catch (error) {
    if (error instanceof InvalidState || error instanceof ValidationFailed || error instanceof Forbidden ||
        error instanceof NotFound) {
      return rejectEarly(error as DomainError)
    }
    throw error
  }

  const events: PendingEvent[] = []
  const jobs: PendingJob[] = []

  try {
    const { result, jobIds } = await prisma.$transaction(async (tx) => {
      // Claim the request id before any side effect: a concurrent call with the same id waits
      // here, then finds the first call's receipt instead of running (and emailing) again.
      if (clientRequestId && !options.resumeReceiptId) {
        // "|" cannot appear in client request ids, so keys of different requests never collide.
        const lockKey = `${organizationId}|${key}|${clientRequestId}`
        await acquireBoundedAdvisoryLock(tx, lockKey)
        const existing = await tx.commandReceipt.findUnique({
          where: {
            organizationId_actorKey_clientRequestId: { organizationId, actorKey: key, clientRequestId },
          },
          select: { id: true },
        })
        if (existing) {
          throw new AlreadyRecorded()
        }
      }

      if (["invoice.send", "credit_note.issue", "agreement.send", "agreement.issue"].includes(definition.type) && !issuanceStagingId) {
        throw new HandlerFailed(new InvalidState({ code: "issuance_required", message: "Issue documents through issueDocument with a renderer and artifact store" }))
      }
      // Issuance, completion and sweep acquire the organization lock before document locks. This
      // happens for every command, before its handler runs: a handler that takes a number (invoice,
      // quote, credit note or agreement issuance) then holds the lock that serializes the counters
      // before it locks the document, the same order as `queueForApproval` and `readInScope`.
      await lockArtifactOrganization(tx, organizationId)
      let issuance: import("./services").CommandScope["issuance"]
      if (issuanceStagingId) {
        const staged = await tx.artifactStaging.findUnique({ where: { id: issuanceStagingId } })
        if (!staged) throw new HandlerFailed(new InvalidState({ code: "reservation_missing", message: "Document reservation missing" }))
        const kind = staged.documentKind as ArtifactDocumentKind
        const documentId = kind === "creditNote" ? (input as { invoiceId: string }).invoiceId : (input as { id: string }).id
        await runRead(tx, lockDocument(kind === "creditNote" ? "invoice" : kind, documentId), { actor, organizationId, commandId: provisionalId, now })
        const contactDocument = kind === "agreement" ? await tx.agreement.findFirst({ where: { id: documentId, organizationId }, select: { contactId: true } })
          : await tx.invoice.findFirst({ where: { id: documentId, organizationId }, select: { contactId: true } })
        if (contactDocument) await runRead(tx, lockDocument("contact", contactDocument.contactId, { strength: "no_key_update" }), { actor, organizationId, commandId: provisionalId, now })
        const renderInput = staged.renderInput as unknown as RenderInput
        const prospective = prospectiveRenderInput({ kind, commandInput: input,
          documentId: staged.documentId, number: staged.reservedNumber!, issuedAt: new Date(renderInput.issuedAt),
          method: definition.type === "agreement.issue" ? "manual" : "email" })
        const read = await readInScope(prospective, { actor, organizationId, commandId: provisionalId, now }, tx)
        if (read.kind === "failed") throw new HandlerFailed(read.error)
        try {
          const candidate = await bindIssuanceCandidate(tx, { staging: staged, renderInput: read.value,
            now, leaseNow: options.now ?? new Date(), organizationId,
            requestKey: `${organizationId}:${key}:${clientRequestId}` })
          issuance = { candidateId: candidate.id, documentId: staged.documentId,
            number: staged.reservedNumber!, issuedAt: new Date(renderInput.issuedAt) }
        } catch (error) {
          if (error instanceof InvalidState) throw new HandlerFailed(error)
          throw error
        }
      }

      const reviewedVersion = options.expectedApprovalVersion
      const approvalContext = definition.approvalContext
      const verifyReviewed =
        reviewedVersion && approvalContext
          ? approvalContext(input).pipe(
              Effect.flatMap((current) =>
                current.version === reviewedVersion
                  ? Effect.void
                  : Effect.fail(
                      new InvalidState({
                        message:
                          "The document changed after this request was sent for approval. Ask the agent to request approval again.",
                        code: "changed_since_review",
                      })
                    )
              )
            )
          : Effect.void
      const program = verifyReviewed.pipe(
        Effect.zipRight(definition.handle(input)),
        Effect.provideService(Db, tx),
        Effect.provideService(Command, {
          actor,
          organizationId,
          commandId: provisionalId,
          now,
          approvedByUserId: options.approvedByUserId ?? null,
          expectedApprovalVersion: options.expectedApprovalVersion,
          issuance,
          emit: (event) => events.push(event),
          enqueue: (job) => jobs.push(job),
        })
      )

      const exit = await Effect.runPromiseExit(program)
      if (Exit.isFailure(exit)) {
        const failureOption = Cause.failureOption(exit.cause)
        if (Option.isSome(failureOption)) {
          throw new HandlerFailed(failureOption.value)
        }
        throw Cause.squash(exit.cause)
      }

      if (issuance && !jobs.some(job => (job.payload as { completion?: { target?: { candidateId?: string } } }).completion?.target?.candidateId === issuance.candidateId)) {
        events.push(...await publishCandidate(tx, { candidateId: issuance.candidateId,
          documentId: issuance.documentId, attemptAt: options.now ?? now, organizationId, commandId: provisionalId }))
      }
      await appendEvents(tx, {
        organizationId,
        actor,
        commandId: provisionalId,
        approvedByUserId: options.approvedByUserId ?? null,
        occurredAt: now,
        events,
      })

      const createdJobs = await Promise.all(
        jobs.map((job) =>
          job.dedupeKey
            ? tx.job.upsert({
                where: { dedupeKey: job.dedupeKey },
                create: {
                  organizationId,
                  type: job.type,
                  payload: toJson(job.payload),
                  dedupeKey: job.dedupeKey,
                  runAfter: job.runAfter ?? now,
                },
                update: {},
                select: { id: true },
              })
            : tx.job.create({
                data: {
                  organizationId,
                  type: job.type,
                  payload: toJson(job.payload),
                  runAfter: job.runAfter ?? now,
                },
                select: { id: true },
              })
        )
      )

      const receiptData = {
        commandType: definition.type,
        status: "completed",
        result: serializeResult(exit.value),
        error: Prisma.DbNull,
      }

      if (options.resumeReceiptId) {
        await tx.commandReceipt.update({ where: { id: options.resumeReceiptId }, data: receiptData })
      } else if (clientRequestId) {
        await tx.commandReceipt.create({
          data: { id: provisionalId, organizationId, actorKey: key, clientRequestId, ...receiptData },
        })
      }

      return { result: exit.value, jobIds: createdJobs.map((job) => job.id) }
    }, TRANSACTION_OPTIONS)

    if (jobIds.length > 0) {
      await runJobsNow(jobIds)
    }

    return { status: "completed", commandId: provisionalId, result }
  } catch (error) {
    if (error instanceof AlreadyRecorded && clientRequestId) {
      const existing = await loadReceiptOutcome<Result>(organizationId, key, clientRequestId)
      if (existing) {
        return existing
      }
    }

    if (clientRequestId && !options.resumeReceiptId && isUniqueViolation(error)) {
      const existing = await loadReceiptOutcome<Result>(organizationId, key, clientRequestId)
      if (existing) {
        return existing
      }
    }

    if (!(error instanceof HandlerFailed)) {
      domainLogger.error("command.crashed", {
        commandType: definition.type,
        organizationId,
        actorKind: actor.kind,
        error,
      })
      throw error
    }

    const outcome = failure(provisionalId, error.domainError)
    const staleNumber = error.domainError._tag === "InvalidState" && error.domainError.code === NUMBER_CHANGED
    const winner = await recordFailedReceipt<Result>(definition.type, outcome, {
      organizationId,
      key,
      clientRequestId,
      resumeReceiptId: options.resumeReceiptId,
      // A stale document number is not the caller's failure: leaving no receipt lets the same
      // request id prepare the document again with the current number.
      transient: error.domainError._tag === "ExternalFailure" || staleNumber,
      staleNumber,
    })
    return winner ?? outcome
  }
}

/**
 * Stores a failure under the caller's request id. If a concurrent call with the same id already
 * stored an outcome, that outcome wins and is returned so both callers see the same result.
 */
async function recordFailedReceipt<Result>(
  commandType: string,
  outcome: FailedOutcome,
  context: {
    organizationId: string
    key: string
    clientRequestId: string | undefined
    resumeReceiptId: string | undefined
    transient: boolean
    /** The failure is a document number that moved on; the issuance is prepared again, not finished. */
    staleNumber?: boolean
  }
): Promise<CommandOutcome<Result> | null> {
  const data = {
    commandType,
    status: "failed",
    result: Prisma.DbNull,
    error: toJson(outcome.error),
  }

  if (context.resumeReceiptId) {
    // An approved command that lost its number is tried again at once. Recording the loss would show
    // a failure to anyone polling the receipt between tries, and a failed receipt can never be
    // approved again. The receipt keeps awaiting approval until an attempt really ends.
    if (context.staleNumber) return null
    await prisma.commandReceipt.update({ where: { id: context.resumeReceiptId }, data })
    return null
  }

  if (!context.clientRequestId) {
    return null
  }

  // Transient failures (provider outages) stay retryable under the same key, but a concurrent
  // call that already succeeded still wins.
  if (context.transient) {
    return loadReceiptOutcome<Result>(context.organizationId, context.key, context.clientRequestId)
  }

  try {
    await prisma.commandReceipt.create({
      data: {
        id: outcome.commandId,
        organizationId: context.organizationId,
        actorKey: context.key,
        clientRequestId: context.clientRequestId,
        ...data,
      },
    })
    return null
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error
    }
    return loadReceiptOutcome<Result>(context.organizationId, context.key, context.clientRequestId)
  }
}

type ReadScope = { actor: Actor; organizationId: string; commandId: string; now: Date }

/**
 * Runs a read-only domain effect (no events, no jobs) in `tx`. A domain failure is thrown as
 * `HandlerFailed`.
 */
async function runRead<Value>(
  tx: Prisma.TransactionClient,
  effect: Effect.Effect<Value, DomainError, Db | Command>,
  scope: ReadScope
): Promise<Value> {
  const exit = await Effect.runPromiseExit(
    effect.pipe(
      Effect.provideService(Db, tx),
      Effect.provideService(Command, {
        ...scope,
        approvedByUserId: null,
        emit: () => undefined,
        enqueue: () => undefined,
      })
    )
  )
  if (Exit.isFailure(exit)) {
    const failureOption = Cause.failureOption(exit.cause)
    if (Option.isSome(failureOption)) {
      throw new HandlerFailed(failureOption.value)
    }
    throw Cause.squash(exit.cause)
  }
  return exit.value
}

/** Runs a read-only domain effect in its own transaction, returning a domain failure as a value. */
async function readInScope<Value>(
  effect: Effect.Effect<Value, DomainError, Db | Command>,
  scope: ReadScope,
  tx?: Prisma.TransactionClient
): Promise<{ kind: "ok"; value: Value } | { kind: "failed"; error: DomainError }> {
  try {
    return { kind: "ok", value: tx ? await runRead(tx, effect, scope) : await prisma.$transaction(async tx => {
      await lockArtifactOrganization(tx, scope.organizationId)
      return runRead(tx, effect, scope)
    }) }
  } catch (error) {
    if (error instanceof HandlerFailed) {
      return { kind: "failed", error: error.domainError }
    }
    throw error
  }
}

async function queueForApproval<Input, Result>(
  definition: CommandDefinition<Input, Result>,
  input: Input,
  context: {
    actor: Extract<Actor, { kind: "agent" }>
    organizationId: string
    key: string
    clientRequestId: string
    commandId: string
    now: Date
  }
): Promise<CommandOutcome<Result>> {
  try {
    const approval = await prisma.$transaction(async (tx) => {
      await lockArtifactOrganization(tx, context.organizationId)
      let review: ApprovalContext | null = null
      if (definition.approvalContext) {
        review = await runRead(tx, definition.approvalContext(input), context)
      }
      const summary = review?.summary ?? definition.summarize(input)

      await tx.commandReceipt.create({
        data: {
          id: context.commandId,
          organizationId: context.organizationId,
          actorKey: context.key,
          clientRequestId: context.clientRequestId,
          commandType: definition.type,
          status: "awaiting_approval",
        },
      })

      const request = await tx.approvalRequest.create({
        data: {
          organizationId: context.organizationId,
          agentKeyId: context.actor.agentKeyId,
          commandReceiptId: context.commandId,
          commandType: definition.type,
          command: toJson(input),
          summary,
          reviewContext: review
            ? toJson({
                version: review.version,
                details: review.details,
                ...(review.preview ? { preview: review.preview } : {}),
              })
            : Prisma.DbNull,
          expiresAt: new Date(context.now.getTime() + APPROVAL_TTL_MS),
        },
        select: { id: true },
      })

      await appendEvents(tx, {
        organizationId: context.organizationId,
        actor: context.actor,
        commandId: context.commandId,
        approvedByUserId: null,
        occurredAt: context.now,
        events: [
          {
            aggregateType: "approval",
            aggregateId: request.id,
            type: "approval.requested",
            payload: { commandType: definition.type, summary },
          },
        ],
      })

      return request
    })

    domainLogger.info("command.awaiting_approval", {
      organizationId: context.organizationId,
      commandType: definition.type,
      agentKeyId: actorId(context.actor),
    })

    return {
      status: "awaiting_approval",
      commandId: context.commandId,
      approvalRequestId: approval.id,
    }
  } catch (error) {
    // The document the agent wants approved could not be described (e.g. it does not exist).
    if (error instanceof HandlerFailed) {
      return failure(context.commandId, error.domainError)
    }
    if (isUniqueViolation(error)) {
      const existing = await loadReceiptOutcome<Result>(
        context.organizationId,
        context.key,
        context.clientRequestId
      )
      if (existing) {
        return existing
      }
    }
    throw error
  }
}
