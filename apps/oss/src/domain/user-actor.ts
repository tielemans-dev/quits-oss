import { prisma } from "../lib/db"
import type { UserActor } from "./actor"
import { parseOrganizationRoles } from "./permissions"

/** Builds the actor for a signed-in user, or null when they are not a member. */
export async function resolveUserActor(input: {
  organizationId: string
  userId: string
  userName?: string | null
  userEmail?: string | null
}): Promise<UserActor | null> {
  const membership = await prisma.member.findFirst({
    where: { organizationId: input.organizationId, userId: input.userId },
    select: { role: true },
  })
  if (!membership) {
    return null
  }

  return {
    kind: "user",
    organizationId: input.organizationId,
    userId: input.userId,
    roles: parseOrganizationRoles(membership.role),
    label: input.userName?.trim() || input.userEmail?.trim() || "User",
  }
}
