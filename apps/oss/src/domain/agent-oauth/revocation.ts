import { agentModeSchema } from "@quits/contracts/agent"
import { prisma } from "../../lib/db"
import { closeRevokedKeyApprovals } from "../agent-keys"
import { appendEvents } from "../events"
import type { TokenFamily } from "./store"

/**
 * Called only after a token hash and its client binding identify the installation.
 * Possession authorizes disconnecting that installation even after the owner leaves;
 * it does not authorize revoking any other key or taking any other action.
 */
export async function disconnectInstallation(family: TokenFamily, now: Date) {
  await prisma.$transaction(async (tx) => {
    const key = await tx.agentKey.findFirst({ where: {
      id: family.agentKeyId,
      organizationId: family.organizationId,
      createdByUserId: family.userId,
      displayPrefix: { startsWith: "connector:" },
    } })
    if (!key) return
    const updated = await tx.agentKey.updateMany({ where: { id: key.id, revokedAt: null }, data: { revokedAt: now } })
    if (!updated.count) return
    await appendEvents(tx, {
      organizationId: key.organizationId,
      actor: { kind: "agent", organizationId: key.organizationId, agentKeyId: key.id,
        mode: agentModeSchema.parse(key.mode), scopes: [], ownerRoles: [], label: key.name },
      commandId: null, approvedByUserId: null, occurredAt: now,
      events: [{ aggregateType: "agentKey", aggregateId: key.id, type: "agent_key.revoked", payload: {} }],
    })
  })
  // Retrying a disconnect also finishes cleanup if a previous request failed after commit.
  await closeRevokedKeyApprovals({ agentKeyId: family.agentKeyId, organizationId: family.organizationId }, now)
}
