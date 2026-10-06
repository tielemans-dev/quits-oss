import { randomUUID } from "node:crypto"
import { Cause, Effect, Exit, Option } from "effect"
import type { CommandError, CommandRecord } from "@yaip/contracts/agent"
import { Prisma } from "../../generated/prisma/client"
import { prisma } from "../lib/db"
import { appLogger } from "../lib/observability"
import { actorCan, actorId, actorKey, type Actor } from "./actor"
import type { CommandDefinition } from "./command"
import {
  Forbidden,
  ValidationFailed,
  serializeDomainError,
  type DomainError,
} from "./errors"
import { appendEvents } from "./events"
import { deserializeResult, serializeResult } from "./serialization"
import { runJobsNow } from "./jobs"
import { Command, Db, type PendingEvent, type PendingJob } from "./services"

const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000
const domainLogger = appLogger.child("domain")

export type ExecuteOptions = {
  actor: Actor
  /** Caller-chosen idempotency key. Retrying with the same key returns the first outcome. */
  clientRequestId?: string
  /** Set when a human approved a queued agent command. */
  approvedByUserId?: string
  /** Receipt created when the command was queued for approval. */
  resumeReceiptId?: string
  now?: Date
}

export type CommandOutcome<Result> =
  | { status: "completed"; commandId: string; result: Result }
  | { status: "awaiting_approval"; commandId: string; approvalRequestId: string }
  | { status: "failed" | "rejected" | "expired"; commandId: string; error: CommandError }

/** Internal signal used to roll back the transaction when the handler fails. */
class HandlerFailed extends Error {
  constructor(readonly domainError: DomainError) {
    super(domainError.message)
  }
}

function isUniqueViolation(error: unknown) {
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

  const provisionalId = options.resumeReceiptId ?? `cmd_${randomUUID().replaceAll("-", "")}`

  if (actor.kind === "agent" && actor.mode === "read_only") {
    return failure(
      provisionalId,
      new Forbidden({ message: "This agent key is read-only", permission: definition.permission })
    )
  }

  if (!actorCan(actor, definition.permission)) {
    return failure(
      provisionalId,
      new Forbidden({
        message: `Missing permission ${definition.permission}`,
        permission: definition.permission,
      })
    )
  }

  const parsed = definition.input.safeParse(rawInput)
  if (!parsed.success) {
    return failure(
      provisionalId,
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

  const needsApproval =
    actor.kind === "agent" &&
    actor.mode === "approval_required" &&
    definition.outwardFacing &&
    !options.approvedByUserId

  if (needsApproval) {
    return queueForApproval(definition, input, {
      actor,
      organizationId,
      key,
      clientRequestId: clientRequestId ?? provisionalId,
      commandId: provisionalId,
      now,
    })
  }

  const events: PendingEvent[] = []
  const jobs: PendingJob[] = []

  try {
    const { result, jobIds } = await prisma.$transaction(async (tx) => {
      const program = definition.handle(input).pipe(
        Effect.provideService(Db, tx),
        Effect.provideService(Command, {
          actor,
          organizationId,
          commandId: provisionalId,
          now,
          approvedByUserId: options.approvedByUserId ?? null,
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
    })

    if (jobIds.length > 0) {
      await runJobsNow(jobIds)
    }

    return { status: "completed", commandId: provisionalId, result }
  } catch (error) {
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
    await recordFailedReceipt(definition.type, outcome, {
      organizationId,
      key,
      clientRequestId,
      resumeReceiptId: options.resumeReceiptId,
      transient: error.domainError._tag === "ExternalFailure",
    })
    return outcome
  }
}

async function recordFailedReceipt(
  commandType: string,
  outcome: FailedOutcome,
  context: {
    organizationId: string
    key: string
    clientRequestId: string | undefined
    resumeReceiptId: string | undefined
    transient: boolean
  }
) {
  const data = {
    commandType,
    status: "failed",
    result: Prisma.DbNull,
    error: toJson(outcome.error),
  }

  if (context.resumeReceiptId) {
    await prisma.commandReceipt.update({ where: { id: context.resumeReceiptId }, data })
    return
  }

  // Transient failures (provider outages) stay retryable under the same key.
  if (!context.clientRequestId || context.transient) {
    return
  }

  await prisma.commandReceipt
    .create({
      data: {
        id: outcome.commandId,
        organizationId: context.organizationId,
        actorKey: context.key,
        clientRequestId: context.clientRequestId,
        ...data,
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) {
        throw error
      }
    })
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
          summary: definition.summarize(input),
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
            payload: { commandType: definition.type, summary: definition.summarize(input) },
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
