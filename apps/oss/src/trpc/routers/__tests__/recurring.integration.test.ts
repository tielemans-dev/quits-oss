import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

describeIfDatabase("recurring router", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function setup(role: "admin" | "accountant" = "admin") {
    const org = await createTestOrganization({ roles: ["admin", "accountant"] })
    cleanups.push(org.cleanup)
    const caller = (userId: string) =>
      appRouter.createCaller({
        session: {
          user: { id: userId, email: `${userId}@example.com`, name: userId },
          session: { activeOrganizationId: org.organizationId },
        },
      } as never)
    const contact = await prisma.contact.create({
      data: { organizationId: org.organizationId, name: "Acme", email: "billing@acme.test" },
    })
    return { org, contact, caller: caller(org.actors[role].userId), admin: caller(org.actors.admin.userId) }
  }

  it("creates, lists, generates, and shows generated invoices", async () => {
    const { caller, contact } = await setup()
    const today = new Date().toISOString().slice(0, 10)

    const created = await caller.recurring.create({
      name: "Hosting",
      contactId: contact.id,
      items: [{ description: "Hosting", quantity: 2, unitPrice: 50 }],
      taxRate: 10,
      intervalCount: 3,
      intervalUnit: "month",
      startDate: today,
      dueInDays: 30,
      end: { type: "after_runs", runs: 4 },
    })
    expect(created).toMatchObject({ status: "active", taxRate: 10, subtotal: 100, remainingRuns: 4 })

    const run = await caller.recurring.runNow({ id: created.id })
    expect(run.invoice?.number).toMatch(/^INV-/)

    const [listed] = await caller.recurring.list()
    expect(listed).toMatchObject({
      id: created.id,
      contact: { name: "Acme" },
      invoiceCount: 1,
      remainingRuns: 3,
      lastInvoice: { number: run.invoice?.number, status: "draft", total: 110 },
    })

    const detail = await caller.recurring.get({ id: created.id })
    expect(detail.invoices).toHaveLength(1)
    expect(detail.lastProblem).toBeNull()

    const paused = await caller.recurring.setStatus({ id: created.id, status: "paused" })
    expect(paused.status).toBe("paused")
    const resumed = await caller.recurring.resume({ id: created.id })
    expect(resumed.status).toBe("active")
  })

  it("lets accountants read but not change schedules", async () => {
    const { caller, contact } = await setup("accountant")
    await expect(caller.recurring.list()).resolves.toEqual([])
    await expect(
      caller.recurring.create({
        name: "Nope",
        contactId: contact.id,
        items: [{ description: "x", quantity: 1, unitPrice: 1 }],
        startDate: new Date().toISOString().slice(0, 10),
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})
