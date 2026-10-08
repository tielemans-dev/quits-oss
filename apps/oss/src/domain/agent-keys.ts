import { createHash, randomBytes } from "node:crypto"
import type { Prisma } from "../../generated/prisma/client"
import { agentKeyCreateInputSchema, type AgentKeyCreateInput, type AgentMode } from "@quits/contracts/agent"
import { prisma } from "../lib/db"
import { actorCan, type AgentActor, type UserActor } from "./actor"
import { closePendingApprovals } from "./approvals"
import { Forbidden, NotFound, ValidationFailed } from "./errors"
import { appendEvents } from "./events"
import { isPermission, parseOrganizationRoles, type Permission } from "./permissions"

const SECRET_PREFIX = "quits_ak_"
/** Keys issued before the product was renamed; they keep working. */
const LEGACY_SECRET_PREFIX = "yaip_ak_"
const LAST_USED_WRITE_INTERVAL_MS = 60_000

export function hashAgentSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex")
}

function generateSecret() {
  return `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`
}

function assertCan(user: UserActor, permission: Permission) {
  if (!actorCan(user, permission)) {
    throw new Forbidden({ message: `Missing permission ${permission}`, permission })
  }
}

/** Creates a key and returns its secret once. Only the hash is stored. */
export async function createAgentKey(user: UserActor, rawInput: AgentKeyCreateInput, now = new Date()) {
  assertCan(user, "agent:create")

  const parsed = agentKeyCreateInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new ValidationFailed({ message: "Invalid agent key input" })
  }
  const input = parsed.data

  const unknownScopes = input.scopes.filter((scope) => !isPermission(scope))
  if (unknownScopes.length > 0) {
    throw new ValidationFailed({
      message: `Unknown scopes: ${unknownScopes.join(", ")}`,
      issues: unknownScopes.map((scope) => ({ path: "scopes", message: `Unknown scope ${scope}` })),
    })
  }
  const scopes = [...new Set(input.scopes)] as Permission[]
  const beyondCreator = scopes.filter((scope) => !actorCan(user, scope))
  if (beyondCreator.length > 0) {
    throw new Forbidden({
      message: `You cannot grant scopes you do not hold: ${beyondCreator.join(", ")}`,
    })
  }

  const secret = generateSecret()
  const key = await prisma.$transaction(async (tx) => {
    const created = await tx.agentKey.create({
      data: {
        organizationId: user.organizationId,
        name: input.name,
        mode: input.mode,
        scopes,
        secretHash: hashAgentSecret(secret),
        displayPrefix: secret.slice(0, SECRET_PREFIX.length + 6),
        createdByUserId: user.userId,
        expiresAt: input.expiresInDays
          ? new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000)
          : null,
      },
    })
    await appendEvents(tx, {
      organizationId: user.organizationId,
      actor: user,
      commandId: null,
      approvedByUserId: null,
      occurredAt: now,
      events: [
        {
          aggregateType: "agentKey",
          aggregateId: created.id,
          type: "agent_key.created",
          payload: { name: created.name, mode: created.mode, scopes },
        },
      ],
    })
    return created
  })

  return { key: toAgentKeySummary(key), secret }
}

/**
 * Revokes a key and ends its pending approval requests. Calling it again for an already revoked
 * key finishes that cleanup, so a revocation interrupted part way can always be completed.
 */
export async function revokeAgentKey(user: UserActor, agentKeyId: string, now = new Date()) {
  assertCan(user, "agent:revoke")

  const key = await prisma.agentKey.findFirst({
    where: { id: agentKeyId, organizationId: user.organizationId },
    select: { id: true },
  })
  if (!key) {
    throw new NotFound({ message: "Agent key not found", entity: "agentKey", id: agentKeyId })
  }

  await prisma.$transaction(async (tx) => {
    const updated = await tx.agentKey.updateMany({
      where: { id: agentKeyId, revokedAt: null },
      data: { revokedAt: now },
    })
    if (updated.count === 0) {
      return
    }
    await appendEvents(tx, {
      organizationId: user.organizationId,
      actor: user,
      commandId: null,
      approvedByUserId: null,
      occurredAt: now,
      events: [
        { aggregateType: "agentKey", aggregateId: agentKeyId, type: "agent_key.revoked", payload: {} },
      ],
    })
  })

  await closeRevokedKeyApprovals({ agentKeyId, organizationId: user.organizationId }, now)
}

/** Pending requests from a revoked key can never run; end them and their receipts. */
export async function closeRevokedKeyApprovals(
  where: Prisma.ApprovalRequestWhereInput,
  now = new Date()
) {
  await closePendingApprovals({
    where: { ...where, agentKey: { revokedAt: { not: null } } },
    status: "expired",
    error: { tag: "Revoked", message: "The agent key was revoked before anyone decided" },
    decisionNote: "Agent key revoked",
    now,
  })
}

export async function listAgentKeys(user: UserActor) {
  assertCan(user, "agent:read")
  const keys = await prisma.agentKey.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { createdAt: "desc" },
  })
  return keys.map(toAgentKeySummary)
}

function toAgentKeySummary(key: {
  id: string
  name: string
  mode: string
  scopes: string[]
  displayPrefix: string
  createdByUserId: string
  lastUsedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}) {
  return {
    id: key.id,
    name: key.name,
    mode: key.mode as AgentMode,
    scopes: key.scopes,
    displayPrefix: key.displayPrefix,
    createdByUserId: key.createdByUserId,
    lastUsedAt: key.lastUsedAt,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
    createdAt: key.createdAt,
  }
}

async function toAgentActor(
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

/** Whether a bearer value is an agent key secret (as opposed to, say, an OAuth access token). */
export function isAgentKeySecret(secret: string) {
  return secret.startsWith(SECRET_PREFIX) || secret.startsWith(LEGACY_SECRET_PREFIX)
}

/** Used only after successful authentication; approvals and token issuance do not record use. */
async function recordAgentKeyUsage(key: { id: string; lastUsedAt: Date | null }, now: Date) {
  if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
    await prisma.agentKey.update({ where: { id: key.id }, data: { lastUsedAt: now } })
  }
}

/** Authenticates a bearer secret from the agent API. */
export async function authenticateAgentSecret(secret: string, now = new Date()): Promise<AgentActor> {
  if (!isAgentKeySecret(secret)) {
    throw new Forbidden({ message: "Invalid agent key" })
  }

  const key = await prisma.agentKey.findUnique({ where: { secretHash: hashAgentSecret(secret) } })
  if (!key) {
    throw new Forbidden({ message: "Invalid agent key" })
  }

  const actor = await toAgentActor(key, { allowRevoked: false, now })

  await recordAgentKeyUsage(key, now)

  return actor
}

export async function resolveAgentActorById(
  agentKeyId: string,
  options: { now?: Date } & (
    | { allowRevoked: false; recordUsage?: boolean }
    | { allowRevoked: true; recordUsage?: false }
  )
): Promise<AgentActor> {
  const key = await prisma.agentKey.findUnique({ where: { id: agentKeyId } })
  if (!key) {
    throw new NotFound({ message: "Agent key not found", entity: "agentKey", id: agentKeyId })
  }
  const now = options.now ?? new Date()
  const actor = await toAgentActor(key, { allowRevoked: options.allowRevoked, now })
  if (options.recordUsage) {
    await recordAgentKeyUsage(key, now)
  }
  return actor
}
