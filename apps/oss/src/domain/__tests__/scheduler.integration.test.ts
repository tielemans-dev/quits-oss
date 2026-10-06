import "dotenv/config"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { overdueOrganizations } from "../features/overdue"
import { reminderOrganizations } from "../features/reminders"
import { registerJobHandler, runDueJobs } from "../jobs"
import { forEachOrganizationWithinBudget, rotationWindow, type OrganizationSource } from "../scheduler"

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const describeIfDatabase = hasTestDatabase ? describe : describe.skip

describe("rotationWindow", () => {
  const cadencesInMinutes = [1, 2, 5, 10, 15, 30, 60, 360, 1440, 10080]

  it("visits every page within one cycle at common tick cadences, from any start time", () => {
    for (const total of [2, 7, 450, 2001, 10_000]) {
      for (const pageSize of [1, 2, 200]) {
        for (const cadence of cadencesInMinutes) {
          for (const startedAt of [0, 1_234_567_890_123, Date.UTC(2026, 9, 6, 23, 59, 59, 999)]) {
            const { pages, cycle } = rotationWindow(new Date(startedAt), total, pageSize)
            const visited = new Set<number>()
            for (let tick = 0; tick < cycle; tick += 1) {
              visited.add(rotationWindow(new Date(startedAt + tick * cadence * MINUTE), total, pageSize).page)
            }
            expect(visited.size, `${total} orgs, pages of ${pageSize}, every ${cadence} min`).toBe(pages)
          }
        }
      }
    }
  })

  it("keeps the cycle close to the page count", () => {
    expect(rotationWindow(new Date(), 150, 200)).toMatchObject({ pages: 1, cycle: 1, page: 0, offset: 0 })
    expect(rotationWindow(new Date(), 450, 200)).toMatchObject({ pages: 3, cycle: 11 })
    expect(rotationWindow(new Date(), 200 * 50, 200)).toMatchObject({ pages: 50, cycle: 53 })
  })

  it("moves the first organization inside a page between slots", () => {
    const starts = new Set(
      Array.from({ length: 20 }, (_, slot) => rotationWindow(new Date(slot * MINUTE), 200, 200).start)
    )
    expect(starts.size).toBeGreaterThan(10)
  })
})

describe("forEachOrganizationWithinBudget", () => {
  function sourceOf(organizationIds: string[]): OrganizationSource {
    return {
      count: async () => organizationIds.length,
      page: async (offset, limit) => organizationIds.slice(offset, offset + limit),
    }
  }

  it("reaches every organization across restarts when there are more than the budget allows", async () => {
    // Every call starts from nothing, as after a process restart, and the organizations never
    // drain, so starting at the first organization each tick would starve the rest.
    const organizationIds = Array.from({ length: 23 }, (_, index) => `org-${String(index).padStart(2, "0")}`)
    const budget = { maxOrganizations: 4, timeBudgetMs: 60_000 }
    const startedAt = Date.UTC(2026, 9, 6, 8, 3)
    const visited = new Set<string>()
    const { cycle } = rotationWindow(new Date(startedAt), organizationIds.length, budget.maxOrganizations)

    for (let tick = 0; tick < cycle; tick += 1) {
      const result = await forEachOrganizationWithinBudget(
        new Date(startedAt + tick * 5 * MINUTE),
        sourceOf(organizationIds),
        async (organizationId) => {
          visited.add(organizationId)
        },
        budget
      )
      expect(result.processed).toBeLessThanOrEqual(budget.maxOrganizations)
    }

    expect([...visited].sort()).toEqual(organizationIds)
  })

  it("stops starting organizations once the time budget is used", async () => {
    const visited: string[] = []
    const result = await forEachOrganizationWithinBudget(
      new Date(),
      sourceOf(["a", "b", "c"]),
      async (organizationId) => {
        visited.push(organizationId)
        await new Promise((resolve) => setTimeout(resolve, 20))
      },
      { maxOrganizations: 10, timeBudgetMs: 5 }
    )
    expect(visited).toHaveLength(1)
    expect(result).toEqual({ organizations: 3, processed: 1, deferred: 2 })
  })
})

describeIfDatabase("scheduler against the database", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function organizationWithInvoices(
    invoices: Array<{ dueInDays: number; amountPaid?: number; status?: string }>,
    options: { email?: string; reminders?: boolean } = {}
  ) {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    if (options.reminders) {
      await prisma.orgSettings.update({
        where: { organizationId: org.organizationId },
        data: { reminderPolicy: { enabled: true, offsetsDays: [7] } },
      })
    }
    const contact = await prisma.contact.create({
      data: { organizationId: org.organizationId, name: "Acme", email: options.email ?? "billing@acme.test" },
    })
    await prisma.invoice.createMany({
      data: invoices.map((invoice) => ({
        organizationId: org.organizationId,
        contactId: contact.id,
        number: `INV-${randomUUID().slice(0, 8)}`,
        status: invoice.status ?? "sent",
        issueDate: new Date(Date.now() - 60 * DAY),
        dueDate: new Date(Date.now() + invoice.dueInDays * DAY),
        subtotalNet: 100,
        totalGross: 100,
        amountPaid: invoice.amountPaid ?? 0,
      })),
    })
    return org.organizationId
  }

  it("selects overdue organizations in the database, ignoring settled invoices", async () => {
    const pastDue = await organizationWithInvoices([{ dueInDays: -5 }, { dueInDays: -10 }])
    const settled = await organizationWithInvoices([{ dueInDays: -5, amountPaid: 100 }])
    const notYetDue = await organizationWithInvoices([{ dueInDays: 5 }])
    const source = overdueOrganizations(new Date(), { organizationIds: [pastDue, settled, notYetDue] })

    expect(await source.count()).toBe(1)
    expect(await source.page(0, 10)).toEqual([pastDue])
    expect(await source.page(1, 10)).toEqual([])
  })

  it("selects reminder organizations with reminders on and an open invoice with a balance", async () => {
    const eligible = await organizationWithInvoices([{ dueInDays: -10 }, { dueInDays: -20 }], { reminders: true })
    const remindersOff = await organizationWithInvoices([{ dueInDays: -10 }])
    const settled = await organizationWithInvoices([{ dueInDays: -10, amountPaid: 100 }], { reminders: true })
    const noRecipient = await organizationWithInvoices([{ dueInDays: -10 }], { reminders: true, email: " " })
    const source = reminderOrganizations({ organizationIds: [eligible, remindersOff, settled, noRecipient] })

    expect(await source.count()).toBe(1)
    expect(await source.page(0, 10)).toEqual([eligible])
  })

  it("rotates through more overdue organizations than the budget across restarts", async () => {
    const organizationIds = await Promise.all(
      Array.from({ length: 5 }, () => organizationWithInvoices([{ dueInDays: -3 }]))
    )
    const source = overdueOrganizations(new Date(), { organizationIds })
    const budget = { maxOrganizations: 2, timeBudgetMs: 60_000 }
    const startedAt = Date.now()
    const { cycle } = rotationWindow(new Date(startedAt), organizationIds.length, budget.maxOrganizations)
    const visited = new Set<string>()

    for (let tick = 0; tick < cycle; tick += 1) {
      await forEachOrganizationWithinBudget(
        new Date(startedAt + tick * 15 * MINUTE),
        source,
        async (organizationId) => {
          visited.add(organizationId)
        },
        budget
      )
    }

    expect([...visited].sort()).toEqual([...organizationIds].sort())
  })

  describe("job sweep", () => {
    async function queueJobs(organizationId: string, type: string, attempts: number[]) {
      return Promise.all(
        attempts.map((attemptsSoFar) =>
          prisma.job.create({
            data: { organizationId, type, payload: {}, attempts: attemptsSoFar, runAfter: new Date(Date.now() - 1000) },
          })
        )
      )
    }

    it("reports retryable and exhausted failures", async () => {
      const organizationId = await organizationWithInvoices([])
      registerJobHandler("test.always_fails", async () => {
        throw new Error("provider down")
      })
      registerJobHandler("test.succeeds", async () => undefined)
      await queueJobs(organizationId, "test.always_fails", [0, 4])
      await queueJobs(organizationId, "test.succeeds", [0])
      const abandoned = await prisma.job.create({
        data: { organizationId, type: "test.succeeds", payload: {}, status: "running", attempts: 5 },
      })
      await prisma.$executeRaw`UPDATE "job" SET "updatedAt" = NOW() - INTERVAL '30 minutes' WHERE "id" = ${abandoned.id}`

      const result = await runDueJobs({ organizationIds: [organizationId] })

      expect(result).toEqual({ processed: 3, succeeded: 1, retrying: 1, failed: 2, deferred: 0, reclaimed: 1 })
      expect(
        await prisma.job.groupBy({ by: ["status"], where: { organizationId }, _count: true, orderBy: { status: "asc" } })
      ).toEqual([
        { status: "done", _count: 1 },
        { status: "failed", _count: 2 },
        { status: "pending", _count: 1 },
      ])
    })

    it("claims no new job once the time budget is used", async () => {
      const organizationId = await organizationWithInvoices([])
      registerJobHandler("test.slow", async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
      })
      await queueJobs(organizationId, "test.slow", [0, 0, 0])

      const first = await runDueJobs({ organizationIds: [organizationId], timeBudgetMs: 10 })
      expect(first).toMatchObject({ processed: 1, succeeded: 1, deferred: 2 })
      expect(await prisma.job.count({ where: { organizationId, status: "pending" } })).toBe(2)

      const second = await runDueJobs({ organizationIds: [organizationId] })
      expect(second).toMatchObject({ processed: 2, succeeded: 2, deferred: 0 })
    })
  })
})
