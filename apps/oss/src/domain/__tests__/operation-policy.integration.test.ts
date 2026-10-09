import { afterEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../lib/db"
import { setRuntimeServices, resetRuntimeServices } from "../../lib/runtime/services"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createContact } from "../commands/contacts"
import { executeCommand } from "../execute"
import { registerJobHandler, runJobsNow } from "../jobs"
import { runRecurringTick } from "../features/recurring"
import { createRecurringInvoice } from "../commands/recurring"

describe.skipIf(!hasTestDatabase)("runtime operation policy at execution", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    resetRuntimeServices()
    while (cleanups.length) await cleanups.pop()?.()
  })
  async function setup() {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    return org
  }

  it("self-host has no policy restrictions; a distribution can refuse all actor kinds without writes", async () => {
    const org = await setup()
    const allowed = await executeCommand(createContact, { name: "Allowed" }, { actor: org.actors.admin })
    expect(allowed.status).toBe("completed")
    const authorize = vi.fn(async () => ({ allowed: false as const, message: "Synthetic restriction" }))
    setRuntimeServices({ operationPolicy: { authorize } })
    for (const actor of [org.actors.admin,
      { kind: "agent" as const, organizationId: org.organizationId, agentKeyId: "synthetic", mode: "full_access" as const,
        scopes: ["contact:create" as const], ownerRoles: ["admin" as const], label: "Synthetic" },
      { kind: "system" as const, organizationId: org.organizationId, reason: "recurring" as const, label: "Synthetic" }]) {
      const outcome = await executeCommand(createContact, { name: "Denied" }, { actor, clientRequestId: "retry-policy" })
      expect(outcome).toMatchObject({ status: "failed", error: { code: "operation_not_allowed" } })
    }
    expect(await prisma.contact.count({ where: { organizationId: org.organizationId } })).toBe(1)
    expect(await prisma.commandReceipt.count({ where: { organizationId: org.organizationId } })).toBe(0)
    resetRuntimeServices()
    expect((await executeCommand(createContact, { name: "Recovered" }, { actor: org.actors.admin, clientRequestId: "retry-policy" })).status).toBe("completed")
  })

  it("rechecks after preparation and refuses a command whose authorization expired before its transaction", async () => {
    const org = await setup()
    const authorize = vi.fn(async ({ phase }: { phase: string }) => phase === "prepare"
      ? { allowed: true as const } : { allowed: false as const, message: "Expired during preparation" })
    setRuntimeServices({ operationPolicy: { authorize } })
    const result = await executeCommand(createContact, { name: "Denied" }, { actor: org.actors.admin, clientRequestId: "expires" })
    expect(result).toMatchObject({ status: "failed", error: { code: "operation_not_allowed" } })
    expect(authorize.mock.calls.map(call => call[0].phase)).toEqual(["prepare", "execute"])
    expect(await prisma.contact.count({ where: { organizationId: org.organizationId } })).toBe(0)
    expect(await prisma.domainEvent.count({ where: { organizationId: org.organizationId } })).toBe(0)
    expect(await prisma.commandReceipt.count({ where: { organizationId: org.organizationId } })).toBe(0)
  })

  it("checks queued jobs at actual execution, deferring new work but preserving reminder handlers and retry budget", async () => {
    const org = await setup()
    const newWork = vi.fn(async () => undefined)
    const reminder = vi.fn(async () => undefined)
    registerJobHandler("test.new_work", newWork); registerJobHandler("test.existing_reminder", reminder)
    const job = await prisma.job.create({ data: { organizationId: org.organizationId, type: "test.new_work", payload: {} } })
    const existing = await prisma.job.create({ data: { organizationId: org.organizationId, type: "test.existing_reminder", payload: {} } })
    setRuntimeServices({ operationPolicy: { authorize: async operation => operation.name === "test.new_work"
      ? { allowed: false, message: "Synthetic restriction" } : { allowed: true } } })
    const now = new Date()
    const result = await runJobsNow([job.id, existing.id], now)
    expect(result).toMatchObject({ deferred: 1, succeeded: 1, failed: 0 })
    expect(newWork).not.toHaveBeenCalled(); expect(reminder).toHaveBeenCalledOnce()
    expect(await prisma.job.findUnique({ where: { id: job.id } })).toMatchObject({ status: "pending", attempts: 0 })
    resetRuntimeServices()
    await runJobsNow([job.id], new Date(now.getTime() + 60_000))
    expect(newWork).toHaveBeenCalledOnce()
  })

  it("defers due recurring generation without advancing or pausing the schedule", async () => {
    const org = await setup()
    const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Synthetic" } })
    const runDate = new Date("2026-10-09T12:00:00Z")
    const created = await executeCommand(createRecurringInvoice, {
      name: "Synthetic monthly", contactId: contact.id, startDate: runDate.toISOString(),
      dueInDays: 14, autoSend: false, items: [{ description: "Synthetic", quantity: 1, unitPrice: 100, taxRate: 25 }],
    }, { actor: org.actors.admin })
    expect(created.status).toBe("completed")
    const before = await prisma.recurringInvoice.findFirstOrThrow({ where: { organizationId: org.organizationId } })
    setRuntimeServices({ operationPolicy: { authorize: async operation => operation.name === "recurring.generate_run"
      ? { allowed: false, message: "Synthetic restriction" } : { allowed: true } } })
    await runRecurringTick(runDate, { organizationIds: [org.organizationId] })
    expect(await prisma.recurringInvoice.findFirst({ where: { organizationId: org.organizationId } })).toMatchObject({ status: "active", nextRunAt: before.nextRunAt })
    expect(await prisma.invoice.count({ where: { organizationId: org.organizationId } })).toBe(0)
  })
})
