import { randomUUID } from "node:crypto"
import type { Prisma } from "../../generated/prisma/client"
import type { UserActor } from "../domain/actor"
import { deleteOrganizationRows } from "../domain/organization-purge"
import { resolveUserActor } from "../domain/user-actor"
import { prisma } from "../lib/db"
import { bootstrapQuitsRuntime } from "../lib/runtime/bootstrap"
import { ensureTestMembership } from "./membership"

export const hasTestDatabase = Boolean(process.env.DATABASE_URL)

/** Test fixtures only: remove scoped records bottom-up, including retained financial evidence. */
export async function cleanupTestOrganizations({ where }: { where: Prisma.OrganizationWhereInput }) {
  const organizations = await prisma.organization.findMany({ where, select: { id: true } })
  const ids = organizations.map(({ id }) => id)
  if (!ids.length) return
  await prisma.$transaction(db => deleteOrganizationRows(db, ids), { timeout: 30_000 })
}

type Role = "admin" | "member" | "accountant"

/** Creates an onboarded organization with one user per requested role. */
export async function createTestOrganization(
  options: {
    roles?: Role[]
    settings?: Partial<{
      momsRegistered: boolean | null
      countryCode: string
      locale: string
      timezone: string
      currency: string
      taxRegime: string
      taxRate: number | null
      pricesIncludeTax: boolean
      companyName: string
      companyEmail: string
    }>
  } = {}
) {
  bootstrapQuitsRuntime({})
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
      momsRegistered: settings.momsRegistered === undefined ? true : settings.momsRegistered,
      countryCode: settings.countryCode ?? "US",
      locale: settings.locale ?? "en-US",
      timezone: settings.timezone ?? "UTC",
      defaultCurrency: settings.currency ?? "USD",
      baseCurrency: settings.currency ?? "USD",
      currency: settings.currency ?? "USD",
      taxRegime: settings.taxRegime ?? "us_sales_tax",
      taxRate: settings.taxRate ?? null,
      pricesIncludeTax: settings.pricesIncludeTax ?? false,
      // MOCK: an onboarded synthetic seller has a known postal identity for linked issuance.
      companyAddress: "1 Synthetic Street, Test City",
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
      await cleanupTestOrganizations({ where: { id: organizationId } })
    },
  }
}
