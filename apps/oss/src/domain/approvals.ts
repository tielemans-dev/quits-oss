import type { Prisma } from "../../generated/prisma/client"
import { prisma } from "../lib/db"
import { actorCan, type AgentActor, type UserActor } from "./actor"
import { resolveAgentActorById } from "./agent-keys"
import { Forbidden, InvalidState, NotFound, serializeDomainError } from "./errors"
import { appendEvents } from "./events"
import { executeCommand, receiptToOutcome, type CommandOutcome } from "./execute"
import { getCommandDefinition } from "./registry"

export type ApprovalDecision = "approve" | "reject"

/** A recovery attempt only resumes an approved command whose last attempt is this old. */
const RESUME_AFTER_MS = 2 * 60 * 1000

function rejection(tag: string, message: string): Prisma.InputJsonValue {
  return { tag, message }
}

async function loadOutcome(receiptId: string) {
  const receipt = await prisma.commandReceipt.findUniqueOrThrow({ where: { id: receiptId } })
  return receiptToOutcome(receipt)
}

export async function listApprovalRequests(input: {
  organizationId: string
  status?: "pending" | "approved" | "rejected" | "expired"
  limit?: number
}) {
  await expireStaleApprovals(input.organizationId)
  return prisma.approvalRequest.findMany({
    where: { organizationId: input.organizationId, ...(input.status ? { status: input.status } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(input.limit ?? 50, 200),
    include: { agentKey: { select: { id: true, name: true, displayPrefix: true } } },
  })
}

/**
 * Ends pending requests and their receipts with a terminal error. Each request is claimed
 * conditionally, so a request someone is approving at the same moment is never overwritten.
 */
export async function closePendingApprovals(input: {
  where: Prisma.ApprovalRequestWhereInput
  status: "expired"
  error: { tag: string; message: string }
  decisionNote?: string
  now: Date
}) {
  const pending = await prisma.approvalRequest.findMany({
    where: { ...input.where, status: "pending" },
    select: { id: true, commandReceiptId: true },
  })

  for (const request of pending) {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.approvalRequest.updateMany({
        where: { id: request.id, status: "pending" },
        data: { status: input.status, decidedAt: input.now, decisionNote: input.decisionNote ?? null },
      })
      if (claimed.count === 0) {
        return
      }
      await tx.commandReceipt.updateMany({
        where: { id: request.commandReceiptId, status: "awaiting_approval" },
        data: { status: input.status, error: input.error },
      })
    })
  }
}

export async function expireStaleApprovals(organizationId: string, now = new Date()) {
  await closePendingApprovals({
    where: { organizationId, expiresAt: { lte: now } },
    status: "expired",
    error: { tag: "Expired", message: "The approval request expired before anyone decided" },
    now,
  })
}

async function finalizeRejection(
  request: { id: string; organizationId: string; commandReceiptId: string; commandType: string },
  decider: UserActor,
  note: string | undefined,
  now: Date
) {
  await prisma.$transaction(async (tx) => {
    const updated = await tx.commandReceipt.updateMany({
      where: { id: request.commandReceiptId, status: "awaiting_approval" },
      data: {
        status: "rejected",
        error: rejection("Rejected", note?.trim() || "A person rejected this request"),
      },
    })
    if (updated.count === 0) {
      return
    }
    await appendEvents(tx, {
      organizationId: request.organizationId,
      actor: decider,
      commandId: request.commandReceiptId,
      approvedByUserId: null,
      occurredAt: now,
      events: [
        {
          aggregateType: "approval",
          aggregateId: request.id,
          type: "approval.rejected",
          payload: { commandType: request.commandType, note: note ?? null },
        },
      ],
    })
  })
}

/**
 * Approves or rejects a queued agent command. Approving runs the stored command as the agent,
 * with the approving user recorded on every resulting event.
 *
 * The decision is recoverable: if the process stops after recording a decision but before the
 * receipt is finalized, deciding the same request again finishes the work instead of returning
 * a receipt that is stuck awaiting approval.
 */
export async function decideApproval(input: {
  approvalRequestId: string
  decider: UserActor
  decision: ApprovalDecision
  note?: string
  now?: Date
}): Promise<CommandOutcome<unknown>> {
  const now = input.now ?? new Date()
  await expireStaleApprovals(input.decider.organizationId, now)

  const request = await prisma.approvalRequest.findFirst({
    where: { id: input.approvalRequestId, organizationId: input.decider.organizationId },
  })
  if (!request) {
    throw new NotFound({ message: "Approval request not found", entity: "approvalRequest" })
  }

  const definition = getCommandDefinition(request.commandType)
  if (!definition) {
    throw new InvalidState({
      message: `Unknown command type ${request.commandType}`,
      code: "unknown_command",
    })
  }

  // Deciding either way requires the permission the command needs.
  if (!actorCan(input.decider, definition.permission)) {
    throw new Forbidden({
      message: `Deciding this request requires ${definition.permission}`,
      permission: definition.permission,
    })
  }

  const receipt = await prisma.commandReceipt.findUniqueOrThrow({
    where: { id: request.commandReceiptId },
  })

  let decision: ApprovalDecision
  let recovering = false
  if (request.status === "pending") {
    // Claim the request so two people deciding at once cannot both act on it.
    const claimed = await prisma.approvalRequest.updateMany({
      where: { id: request.id, status: "pending" },
      data: {
        status: input.decision === "approve" ? "approved" : "rejected",
        decidedByUserId: input.decider.userId,
        decidedAt: now,
        decisionNote: input.note ?? null,
      },
    })
    if (claimed.count === 0) {
      return loadOutcome(request.commandReceiptId)
    }
    decision = input.decision
  } else if (receipt.status === "awaiting_approval" && request.status === "approved") {
    decision = "approve"
    recovering = true
  } else if (receipt.status === "awaiting_approval" && request.status === "rejected") {
    decision = "reject"
  } else {
    return receiptToOutcome(receipt)
  }

  if (decision === "reject") {
    await finalizeRejection(request, input.decider, request.decisionNote ?? input.note, now)
    return loadOutcome(request.commandReceiptId)
  }

  let agent: AgentActor
  try {
    agent = await resolveAgentActorById(request.agentKeyId, { allowRevoked: false })
  } catch (error) {
    const domainError =
      error instanceof Forbidden || error instanceof NotFound
        ? error
        : new Forbidden({ message: "The agent key is no longer valid" })
    await prisma.commandReceipt.updateMany({
      where: { id: request.commandReceiptId, status: "awaiting_approval" },
      data: { status: "failed", error: serializeDomainError(domainError) },
    })
    return loadOutcome(request.commandReceiptId)
  }

  // Take a short lease on the receipt so concurrent retries cannot run the command twice. A
  // recovery only proceeds once the previous attempt has had time to finish.
  if (recovering && now.getTime() - receipt.updatedAt.getTime() < RESUME_AFTER_MS) {
    return receiptToOutcome(receipt)
  }
  const lease = await prisma.commandReceipt.updateMany({
    where: { id: receipt.id, status: "awaiting_approval", updatedAt: receipt.updatedAt },
    data: { updatedAt: now },
  })
  if (lease.count === 0) {
    return loadOutcome(request.commandReceiptId)
  }

  const approvedBy = request.decidedByUserId ?? input.decider.userId
  await prisma.$transaction(async (tx) => {
    await appendEvents(tx, {
      organizationId: request.organizationId,
      actor: input.decider,
      commandId: request.commandReceiptId,
      approvedByUserId: approvedBy,
      occurredAt: now,
      events: [
        {
          aggregateType: "approval",
          aggregateId: request.id,
          type: "approval.approved",
          payload: { commandType: request.commandType, note: request.decisionNote ?? input.note ?? null },
        },
      ],
    })
  })

  const reviewed = request.reviewContext as { version?: unknown } | null
  return executeCommand(definition, request.command, {
    actor: agent,
    approvedByUserId: approvedBy,
    resumeReceiptId: request.commandReceiptId,
    expectedApprovalVersion: typeof reviewed?.version === "string" ? reviewed.version : undefined,
    now,
  })
}
