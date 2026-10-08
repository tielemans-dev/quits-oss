import { randomUUID } from "node:crypto"
import type { Prisma } from "../../generated/prisma/client"
import type { UserActor } from "../domain/actor"
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
  const scope = { organizationId: { in: ids } }
  await prisma.$transaction(async (db) => {
    const invoices = await db.invoice.findMany({ where: scope, select: { id: true } })
    const quotes = await db.quote.findMany({ where: scope, select: { id: true } })
    const agreements = await db.agreement.findMany({ where: scope, select: { id: true } })
    await db.publicLinkAttempt.deleteMany({ where: { OR: [
      { documentKind: "invoice", documentId: { in: invoices.map(({ id }) => id) } },
      { documentKind: "quote", documentId: { in: quotes.map(({ id }) => id) } },
      { documentKind: "agreement", documentId: { in: agreements.map(({ id }) => id) } },
    ] } })
    await db.issuanceCandidate.deleteMany({ where: scope })
    await db.artifactStaging.deleteMany({ where: scope })
    await db.approvalRequest.deleteMany({ where: scope })
    await db.agentKey.deleteMany({ where: scope })
    await db.deliverableRebill.deleteMany({ where: { agreement: scope } })
    await db.creditNoteItem.deleteMany({ where: { creditNote: scope } })
    await db.creditNote.deleteMany({ where: scope })
    await db.payment.deleteMany({ where: scope })
    await db.settlementRefund.deleteMany({ where: { receipt: scope } })
    await db.settlementReceipt.deleteMany({ where: scope })
    await db.invoiceReminder.deleteMany({ where: { invoice: scope } })
    await db.invoiceItem.deleteMany({ where: { invoice: scope } })
    await db.invoice.deleteMany({ where: scope })
    await db.deliverable.deleteMany({ where: { agreement: scope } })
    await db.agreement.deleteMany({ where: scope })
    await db.agreementTemplate.deleteMany({ where: scope })
    await db.quoteItem.deleteMany({ where: { quote: scope } })
    await db.quote.deleteMany({ where: scope })
    await db.recurringInvoice.deleteMany({ where: scope })
    await db.contact.deleteMany({ where: scope })
    await db.organizationTaxId.deleteMany({ where: scope })
    await db.orgSettings.deleteMany({ where: scope })
    await db.domainEvent.deleteMany({ where: scope })
    await db.job.deleteMany({ where: scope })
    await db.commandReceipt.deleteMany({ where: scope })
    await db.organization.deleteMany({ where: { id: { in: ids } } })
  }, { timeout: 30_000 })
}

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
      countryCode: settings.countryCode ?? "US",
      locale: settings.locale ?? "en-US",
      timezone: settings.timezone ?? "UTC",
      defaultCurrency: settings.currency ?? "USD",
      baseCurrency: settings.currency ?? "USD",
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
      await cleanupTestOrganizations({ where: { id: organizationId } })
    },
  }
}
