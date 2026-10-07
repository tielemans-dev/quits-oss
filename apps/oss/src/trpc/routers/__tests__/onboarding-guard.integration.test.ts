import { cleanupTestOrganizations } from "../../../test-utils/organization"
import "dotenv/config"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../../lib/db"
import { ensureTestMembership } from "../../../test-utils/membership"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip

type DocumentCaller = {
  invoices: {
    create: (input: Record<string, unknown>) => Promise<unknown>
  }
  quotes: {
    create: (input: Record<string, unknown>) => Promise<unknown>
  }
  onboarding: {
    saveDraft: (input: Record<string, unknown>) => Promise<unknown>
    completeManual: (input: { method?: "manual" | "ai" }) => Promise<unknown>
  }
}

async function createCloudCallerWithContact() {
  vi.resetModules()
  process.env.QUITS_DISTRIBUTION = "cloud"

  const { appRouter } = await import("../../router")
  const orgId = randomUUID()
  const contactId = randomUUID()
  const slug = `guard-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`

  await prisma.organization.create({
    data: {
      id: orgId,
      name: "Guard Org",
      slug,
      createdAt: new Date(),
      subscriptionStatus: "pro",
    },
  })
  await ensureTestMembership(orgId, "guard-user")

  await prisma.contact.create({
    data: {
      id: contactId,
      organizationId: orgId,
      name: "Guard Contact",
      email: "guard@example.com",
    },
  })

  const caller = appRouter.createCaller({
    session: {
      user: {
        id: "guard-user",
        email: "guard-user@example.com",
        name: "Guard User",
      },
      session: {
        activeOrganizationId: orgId,
      },
    },
  } as never) as unknown as DocumentCaller

  return { orgId, contactId, caller }
}

describeIfDatabase("onboarding document guards", () => {
  afterEach(async () => {
    process.env.QUITS_DISTRIBUTION = "selfhost"
  })

  it("blocks invoice and quote creation until onboarding is complete", async () => {
    const { orgId, contactId, caller } = await createCloudCallerWithContact()

    try {
      await expect(
        caller.invoices.create({
          contactId,
          dueDate: "2026-03-10",
          items: [{ description: "Work", quantity: 1, unitPrice: 100 }],
          taxRate: 0,
        })
      ).rejects.toThrow(/Complete onboarding/)

      await expect(
        caller.quotes.create({
          contactId,
          expiryDate: "2026-03-10",
          items: [{ description: "Work", quantity: 1, unitPrice: 100 }],
          taxRate: 0,
        })
      ).rejects.toThrow(/Complete onboarding/)

      await caller.onboarding.saveDraft({
        companyName: "Guard Org",
        companyAddress: "Main St 1",
        companyEmail: "billing@guard.example",
        countryCode: "US",
        locale: "en-US",
        timezone: "UTC",
        defaultCurrency: "USD",
        taxRegime: "us_sales_tax",
        pricesIncludeTax: false,
        invoicePrefix: "INV",
        quotePrefix: "QTE",
      })
      await caller.onboarding.completeManual({ method: "manual" })

      await expect(
        caller.invoices.create({
          contactId,
          dueDate: "2026-03-10",
          items: [{ description: "Work", quantity: 1, unitPrice: 100 }],
          taxRate: 0,
        })
      ).resolves.toBeTruthy()
    } finally {
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  })
})
