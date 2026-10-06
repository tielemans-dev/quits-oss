import type { Prisma } from "../../generated/prisma/client"
import { prisma } from "../lib/db"
import { actorCan, type AgentActor, type UserActor } from "./actor"
import { resolveAgentActorById } from "./agent-keys"
import { Forbidden, InvalidState, NotFound, serializeDomainError } from "./errors"
import { appendEvents } from "./events"
import { executeCommand, receiptToOutcome, type CommandOutcome } from "./execute"
import { getCommandDefinition } from "./registry"

export type ApprovalDecision = "approve" | "reject"

function rejection(tag: string, message: string): Prisma.InputJsonValue {
  return { tag, message }
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

export async function expireStaleApprovals(organizationId: string, now = new Date()) {
  const stale = await prisma.approvalRequest.findMany({
    where: { organizationId, status: "pending", expiresAt: { lte: now } },
    select: { id: true, commandReceiptId: true },
  })

  for (const request of stale) {
    await prisma.$transaction([
      prisma.approvalRequest.update({
        where: { id: request.id },
        data: { status: "expired", decidedAt: now },
      }),
      prisma.commandReceipt.update({
        where: { id: request.commandReceiptId },
        data: {
          status: "expired",
          error: rejection("Expired", "The approval request expired before anyone decided"),
        },
      }),
    ])
  }
}

/**
 * Approves or rejects a queued agent command. Approving runs the stored command as the agent,
 * with the approving user recorded on every resulting event.
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
  if (request.status !== "pending") {
    const receipt = await prisma.commandReceipt.findUniqueOrThrow({
      where: { id: request.commandReceiptId },
    })
    return receiptToOutcome(receipt)
  }

  const definition = getCommandDefinition(request.commandType)
  if (!definition) {
    throw new InvalidState({
      message: `Unknown command type ${request.commandType}`,
      code: "unknown_command",
    })
  }

  if (input.decision === "approve" && !actorCan(input.decider, definition.permission)) {
    throw new Forbidden({
      message: `Approving requires ${definition.permission}`,
      permission: definition.permission,
    })
  }

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
    const receipt = await prisma.commandReceipt.findUniqueOrThrow({
      where: { id: request.commandReceiptId },
    })
    return receiptToOutcome(receipt)
  }

  if (input.decision === "reject") {
    const error = rejection("Rejected", input.note?.trim() || "A person rejected this request")
    await prisma.$transaction(async (tx) => {
      await tx.commandReceipt.update({
        where: { id: request.commandReceiptId },
        data: { status: "rejected", error },
      })
      await appendEvents(tx, {
        organizationId: request.organizationId,
        actor: input.decider,
        commandId: request.commandReceiptId,
        approvedByUserId: null,
        occurredAt: now,
        events: [
          {
            aggregateType: "approval",
            aggregateId: request.id,
            type: "approval.rejected",
            payload: { commandType: request.commandType, note: input.note ?? null },
          },
        ],
      })
    })
    const receipt = await prisma.commandReceipt.findUniqueOrThrow({
      where: { id: request.commandReceiptId },
    })
    return receiptToOutcome(receipt)
  }

  let agent: AgentActor
  try {
    agent = await resolveAgentActorById(request.agentKeyId, { allowRevoked: false })
  } catch (error) {
    const domainError =
      error instanceof Forbidden || error instanceof NotFound
        ? error
        : new Forbidden({ message: "The agent key is no longer valid" })
    await prisma.commandReceipt.update({
      where: { id: request.commandReceiptId },
      data: { status: "failed", error: serializeDomainError(domainError) },
    })
    const receipt = await prisma.commandReceipt.findUniqueOrThrow({
      where: { id: request.commandReceiptId },
    })
    return receiptToOutcome(receipt)
  }

  await prisma.$transaction(async (tx) => {
    await appendEvents(tx, {
      organizationId: request.organizationId,
      actor: input.decider,
      commandId: request.commandReceiptId,
      approvedByUserId: input.decider.userId,
      occurredAt: now,
      events: [
        {
          aggregateType: "approval",
          aggregateId: request.id,
          type: "approval.approved",
          payload: { commandType: request.commandType, note: input.note ?? null },
        },
      ],
    })
  })

  return executeCommand(definition, request.command, {
    actor: agent,
    approvedByUserId: input.decider.userId,
    resumeReceiptId: request.commandReceiptId,
    now,
  })
}
