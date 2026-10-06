import { prisma } from "../lib/db"

/**
 * Router tests call procedures as a user; procedures now require that user to be a
 * member of the active organization. Creates the user (once) and the membership.
 */
export async function ensureTestMembership(
  organizationId: string,
  userId: string,
  role: "admin" | "member" | "accountant" = "admin"
) {
  await prisma.user.upsert({
    where: { id: userId },
    create: {
      id: userId,
      email: `${userId}@test.yaip.invalid`,
      name: userId,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    update: {},
  })

  await prisma.member.create({
    data: {
      id: `${organizationId}:${userId}`,
      organizationId,
      userId,
      role,
      createdAt: new Date(),
    },
  })
}
