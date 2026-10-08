import type { AgentMode } from "@quits/contracts/agent"
import { prisma } from "../lib/db"
import type { AgentActor } from "./actor"
import { Forbidden, NotFound } from "./errors"
import { isPermission, parseOrganizationRoles } from "./permissions"

export async function toAgentActor(
  key: {
    id: string
    organizationId: string
    name: string
    mode: string
    scopes: string[]
    createdByUserId: string
    expiresAt: Date | null
    revokedAt: Date | null
  },
  options: { allowRevoked: boolean; now: Date }
): Promise<AgentActor> {
  if (!options.allowRevoked && key.revokedAt) {
    throw new Forbidden({ message: "Agent key has been revoked" })
  }
  if (key.expiresAt && key.expiresAt <= options.now) {
    throw new Forbidden({ message: "Agent key has expired" })
  }

  const creator = await prisma.member.findFirst({
    where: { organizationId: key.organizationId, userId: key.createdByUserId },
    select: { role: true },
  })
  if (!creator) {
    throw new Forbidden({ message: "The user who created this agent key is no longer a member" })
  }

  return {
    kind: "agent",
    organizationId: key.organizationId,
    agentKeyId: key.id,
    mode: key.mode as AgentMode,
    scopes: key.scopes.filter(isPermission),
    ownerRoles: parseOrganizationRoles(creator.role),
    label: `Agent: ${key.name}`,
  }
}

export async function resolveAgentActorById(
  agentKeyId: string,
  options: { allowRevoked: boolean; now?: Date }
): Promise<AgentActor> {
  const key = await prisma.agentKey.findUnique({ where: { id: agentKeyId } })
  if (!key) {
    throw new NotFound({ message: "Agent key not found", entity: "agentKey", id: agentKeyId })
  }
  return toAgentActor(key, { allowRevoked: options.allowRevoked, now: options.now ?? new Date() })
}
