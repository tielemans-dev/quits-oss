import { randomUUID } from "node:crypto"
import type { UserActor } from "../domain/actor"
import { resolveUserActor } from "../domain/user-actor"
import { prisma } from "../lib/db"
import { ensureTestMembership } from "./membership"

export const hasTestDatabase = Boolean(process.env.DATABASE_URL)

type Role = "admin" | "member" | "accountant"

/** Creates an onboarded organization with one user per requested role. */
export async function createTestOrganization(
  options: {
    roles?: Role[]
    settings?: Partial<{
      countryCode: string
      locale: string
      timezone: string
      currency: string
      taxRegime: string
      pricesIncludeTax: boolean
      companyName: string
      companyEmail: string
    }>
  } = {}
) {
  const organizationId = randomUUID()
  const suffix = organizationId.slice(0, 8)
  await prisma.organization.create({
    data: {
      id: organizationId,
      name: `Test Org ${suffix}`,
      slug: `test-${suffix}-${Date.now()}`,
      createdAt: new Date(),
    },
  })

  const settings = options.settings ?? {}
  await prisma.orgSettings.create({
    data: {
      organizationId,
      countryCode: settings.countryCode ?? "US",
      locale: settings.locale ?? "en-US",
      timezone: settings.timezone ?? "UTC",
      defaultCurrency: settings.currency ?? "USD",
      currency: settings.currency ?? "USD",
      taxRegime: settings.taxRegime ?? "us_sales_tax",
      pricesIncludeTax: settings.pricesIncludeTax ?? false,
      companyName: settings.companyName ?? `Test Org ${suffix}`,
      companyEmail: settings.companyEmail ?? `billing-${suffix}@example.com`,
      onboardingStatus: "completed",
      onboardingCompletedAt: new Date(),
    },
  })

  const actors = {} as Record<Role, UserActor>
  for (const role of options.roles ?? ["admin"]) {
    const userId = `${role}-${suffix}`
    await ensureTestMembership(organizationId, userId, role)
    const actor = await resolveUserActor({ organizationId, userId, userName: `${role} user` })
    if (!actor) {
      throw new Error("membership was not created")
    }
    actors[role] = actor
  }

  return {
    organizationId,
    actors,
    async cleanup() {
      await prisma.job.deleteMany({ where: { organizationId } })
      await prisma.commandReceipt.deleteMany({ where: { organizationId } })
      await prisma.organization.delete({ where: { id: organizationId } })
    },
  }
}
