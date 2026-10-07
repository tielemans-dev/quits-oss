import { TRPCError } from "@trpc/server"
import {
  agentKeyCreateInputSchema,
  agentKeyIdInputSchema,
  approvalDecideInputSchema,
  approvalListInputSchema,
  type CommandStatus,
} from "@quits/contracts/agent"
import { actorCan } from "../../domain/actor"
import { createAgentKey, listAgentKeys, revokeAgentKey } from "../../domain/agent-keys"
import { decideApproval, expireStaleApprovals } from "../../domain/approvals"
import { toCommandRecord } from "../../domain/execute"
import { permissionsForRoles } from "../../domain/permissions"
import { getCommandDefinition } from "../../domain/registry"
import { prisma } from "../../lib/db"
import { authorizedProcedure, orgProcedure, router } from "../init"
import { rethrowDomainError } from "../outcome"

const HISTORY_STATUSES = ["approved", "rejected", "expired"]

async function userNames(userIds: string[]) {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return new Map<string, string>()
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, email: true },
  })
  return new Map(users.map((user) => [user.id, user.name?.trim() || user.email]))
}

export const agentsRouter = router({
  /** What the signed-in user may do here, so the UI only offers allowed actions. */
  access: orgProcedure.query(({ ctx }) => ({
    canRead: actorCan(ctx.actor, "agent:read"),
    canCreate: actorCan(ctx.actor, "agent:create"),
    canRevoke: actorCan(ctx.actor, "agent:revoke"),
    /** Agents never manage other agents, so `agent:*` is not grantable. */
    grantableScopes: permissionsForRoles(ctx.actor.roles).filter(
      (permission) => !permission.startsWith("agent:")
    ),
  })),

  listKeys: authorizedProcedure("agent:read").query(async ({ ctx }) => {
    const keys = await listAgentKeys(ctx.actor).catch(rethrowDomainError)
    const names = await userNames(keys.map((key) => key.createdByUserId))
    return keys.map((key) => ({ ...key, createdByName: names.get(key.createdByUserId) ?? null }))
  }),

  /** Returns the secret exactly once; only its hash is stored. */
  createKey: authorizedProcedure("agent:create")
    .input(agentKeyCreateInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (input.scopes.some((scope) => scope.startsWith("agent:"))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Agents cannot manage agent keys" })
      }
      return createAgentKey(ctx.actor, input).catch(rethrowDomainError)
    }),

  revokeKey: authorizedProcedure("agent:revoke")
    .input(agentKeyIdInputSchema)
    .mutation(async ({ ctx, input }) => {
      await revokeAgentKey(ctx.actor, input.id).catch(rethrowDomainError)
      return { id: input.id }
    }),

  /** Badge count for the sidebar. */
  pendingCount: orgProcedure.query(async ({ ctx }) => {
    await expireStaleApprovals(ctx.organizationId)
    return prisma.approvalRequest.count({
      where: { organizationId: ctx.organizationId, status: "pending" },
    })
  }),

  approvals: orgProcedure.input(approvalListInputSchema).query(async ({ ctx, input }) => {
    await expireStaleApprovals(ctx.organizationId)
    const requests = await prisma.approvalRequest.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: input.view === "pending" ? "pending" : { in: HISTORY_STATUSES },
      },
      orderBy: input.view === "pending" ? { createdAt: "asc" } : { decidedAt: "desc" },
      take: input.limit,
      include: { agentKey: { select: { id: true, name: true, displayPrefix: true, revokedAt: true } } },
    })

    const receipts = await prisma.commandReceipt.findMany({
      where: { id: { in: requests.map((request) => request.commandReceiptId) } },
      select: { id: true, status: true, error: true },
    })
    const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]))
    const deciders = await userNames(
      requests.flatMap((request) => (request.decidedByUserId ? [request.decidedByUserId] : []))
    )

    return requests.map((request) => {
      const definition = getCommandDefinition(request.commandType)
      const receipt = receiptById.get(request.commandReceiptId)
      const error = receipt?.error as { message?: string } | null | undefined
      return {
        id: request.id,
        commandId: request.commandReceiptId,
        commandType: request.commandType,
        command: request.command,
        summary: request.summary,
        reviewDetails:
          ((request.reviewContext as { details?: Record<string, string | number | null> } | null)
            ?.details ?? null),
        status: request.status,
        agent: request.agentKey,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
        decidedAt: request.decidedAt,
        decidedByName: request.decidedByUserId ? (deciders.get(request.decidedByUserId) ?? null) : null,
        decisionNote: request.decisionNote,
        commandStatus: (receipt?.status ?? null) as CommandStatus | null,
        commandError: error?.message ?? null,
        requiredPermission: definition?.permission ?? null,
        canDecide: Boolean(definition && actorCan(ctx.actor, definition.permission)),
      }
    })
  }),

  /**
   * Approving runs the queued command as the agent, recorded as approved by this user.
   * Deciding either way requires the command's own permission.
   */
  decide: orgProcedure.input(approvalDecideInputSchema).mutation(async ({ ctx, input }) => {
    const request = await prisma.approvalRequest.findFirst({
      where: { id: input.approvalRequestId, organizationId: ctx.organizationId },
      select: { commandType: true },
    })
    if (!request) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Approval request not found" })
    }
    const definition = getCommandDefinition(request.commandType)
    if (definition && !actorCan(ctx.actor, definition.permission)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Deciding this request requires ${definition.permission}`,
      })
    }

    const outcome = await decideApproval({
      approvalRequestId: input.approvalRequestId,
      decider: ctx.actor,
      decision: input.decision,
      note: input.note || undefined,
    }).catch(rethrowDomainError)
    // The UI only needs the status; command results stay with the agent that asked for them.
    return { ...toCommandRecord(request.commandType, outcome), result: null }
  }),
})
