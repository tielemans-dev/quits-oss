import { cleanupTestOrganizations } from "../../../test-utils/organization"
import "dotenv/config"
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { prisma } from "../../../lib/db"
import { appRouter } from "../../router"
import { ensureTestMembership } from "../../../test-utils/membership"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip

describeIfDatabase("catalog integration", () => {
  async function createOrgWithCaller(orgName: string) {
    const orgId = randomUUID()
    const slug = `catalog-${orgName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`

    await prisma.organization.create({
      data: {
        id: orgId,
        name: orgName,
        slug,
        createdAt: new Date(),
        subscriptionStatus: "pro",
      },
    })
    await ensureTestMembership(orgId, `user-${orgName}`)

    const caller = appRouter.createCaller({
      session: {
        user: {
          id: `user-${orgName}`,
          email: `${orgName.toLowerCase()}@example.com`,
          name: `${orgName} User`,
        },
        session: {
          activeOrganizationId: orgId,
        },
      },
    } as never)

    return { orgId, caller }
  }

  it("supports org-scoped catalog CRUD", async () => {
    const { orgId: orgAId, caller: callerA } = await createOrgWithCaller("Catalog A")
    const { orgId: orgBId, caller: callerB } = await createOrgWithCaller("Catalog B")

    try {
      const createdA = await callerA.catalog.create({
        name: "Consulting",
        description: "Hourly consulting",
        defaultUnitPrice: 150,
      })
      expect(createdA.name).toBe("Consulting")
      expect(createdA.defaultUnitPrice).toBe(150)

      await callerB.catalog.create({
        name: "Support",
        description: "Priority support",
        defaultUnitPrice: 80,
      })

      const listA = await callerA.catalog.list()
      expect(listA).toHaveLength(1)
      expect(listA[0]).toMatchObject({
        name: "Consulting",
        description: "Hourly consulting",
        defaultUnitPrice: 150,
        isActive: true,
      })

      const updatedA = await callerA.catalog.update({
        id: createdA.id,
        name: "Consulting - Senior",
        description: "Senior consulting",
        defaultUnitPrice: 200,
      })
      expect(updatedA.name).toBe("Consulting - Senior")
      expect(updatedA.defaultUnitPrice).toBe(200)

      await expect(
        callerB.catalog.update({
          id: createdA.id,
          name: "Illegal update",
          description: "Should fail",
          defaultUnitPrice: 999,
        })
      ).rejects.toThrow()

      await callerA.catalog.archive({ id: createdA.id })
      const listAAfterArchive = await callerA.catalog.list()
      expect(listAAfterArchive).toHaveLength(0)
    } finally {
      await cleanupTestOrganizations({
        where: { id: { in: [orgAId, orgBId] } },
      })
    }
  })

  it("keeps invoice line values independent after catalog updates", async () => {
    const { orgId, caller } = await createOrgWithCaller("Catalog Copy Independence")

    try {
      const contact = await prisma.contact.create({
        data: {
          organizationId: orgId,
          name: "Buyer",
          email: "buyer@example.com",
        },
      })

      const item = await caller.catalog.create({
        name: "Consulting",
        description: "Hourly consulting",
        defaultUnitPrice: 100,
      })

      const invoice = await caller.invoices.create({
        contactId: contact.id,
        dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        taxRate: 0,
        items: [
          {
            description: item.description ?? item.name,
            quantity: 2,
            unitPrice: item.defaultUnitPrice,
          },
        ],
      })

      await caller.catalog.update({
        id: item.id,
        name: "Consulting",
        description: "Hourly consulting",
        defaultUnitPrice: 250,
      })

      const reloaded = await caller.invoices.get({ id: invoice.id })
      expect(reloaded.items).toHaveLength(1)
      expect(reloaded.items[0]?.unitPrice).toBe(100)
      expect(reloaded.total).toBe(200)
    } finally {
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  })
})
