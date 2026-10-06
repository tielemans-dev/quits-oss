import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../lib/email", async () => {
  const actual = await vi.importActual<typeof import("../../lib/email")>("../../lib/email")
  return { ...actual, sendInvoiceEmail: vi.fn().mockResolvedValue({ id: "email_123" }) }
})

import type { RecurringCreateInput } from "@yaip/contracts/recurring"
import { prisma } from "../../lib/db"
import { sendInvoiceEmail } from "../../lib/email"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import type { Actor, AgentActor } from "../actor"
import { authenticateAgentSecret, createAgentKey } from "../agent-keys"
import { createContact } from "../commands/contacts"
import {
  createRecurringInvoice,
  generateRecurringRun,
  resumeRecurringInvoice,
  runRecurringInvoiceNow,
  runRequestId,
  recurringSystemActor,
  setRecurringInvoiceStatus,
  updateRecurringInvoice,
} from "../commands/recurring"
import { readActivity } from "../events"
import { executeCommand } from "../execute"
import { runRecurringTick } from "../features/recurring"
import {
  addUtcDays,
  advanceRunDate,
  formatCalendarDate,
  startOfUtcDay,
} from "../features/recurring-dates"
import { runOrganizationJobs, runSchedulerTick } from "../scheduler"
import "../scheduler-tasks"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

const EMAIL_ENV = ["RESEND_API_KEY", "FROM_EMAIL", "YAIP_APP_ORIGIN"] as const

describeIfDatabase("recurring invoices", () => {
  const cleanups: Array<() => Promise<void>> = []
  const previousEnv: Partial<Record<(typeof EMAIL_ENV)[number], string | undefined>> = {}

  beforeEach(() => {
    for (const key of EMAIL_ENV) previousEnv[key] = process.env[key]
  })

  afterEach(async () => {
    for (const key of EMAIL_ENV) {
      if (previousEnv[key] === undefined) delete process.env[key]
      else process.env[key] = previousEnv[key]
    }
    vi.mocked(sendInvoiceEmail).mockReset()
    vi.mocked(sendInvoiceEmail).mockResolvedValue({ id: "email_123" })
    while (cleanups.length) await cleanups.pop()?.()
  })

  function enableEmail() {
    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@example.com"
  }

  async function setup(
    options: { roles?: Array<"admin" | "member" | "accountant">; contactEmail?: string | null } = {}
  ) {
    const org = await createTestOrganization({ roles: options.roles ?? ["admin"] })
    cleanups.push(org.cleanup)
    const contact = await executeCommand(
      createContact,
      {
        name: "Acme",
        ...(options.contactEmail === null ? {} : { email: options.contactEmail ?? "billing@acme.test" }),
      },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    return { org, contactId: contact.result.id }
  }

  const today = () => startOfUtcDay(new Date())

  function scheduleInput(contactId: string, overrides: Partial<RecurringCreateInput> = {}) {
    return {
      name: "Monthly retainer",
      contactId,
      items: [{ description: "Retainer", quantity: 1, unitPrice: 1000 }],
      taxRate: 25,
      intervalCount: 1,
      intervalUnit: "month" as const,
      startDate: formatCalendarDate(today()),
      dueInDays: 14,
      ...overrides,
    }
  }

  async function createSchedule(actor: Actor, contactId: string, overrides: Partial<RecurringCreateInput> = {}) {
    const outcome = await executeCommand(createRecurringInvoice, scheduleInput(contactId, overrides), { actor })
    if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
    return outcome.result
  }

  /** Moves a schedule into the past so the tick has missed runs to catch up on. */
  async function backdate(id: string, startDate: Date, extra: Record<string, unknown> = {}) {
    await prisma.recurringInvoice.update({
      where: { id },
      data: { startDate, nextRunAt: startDate, ...extra },
    })
  }

  function monthsAgo(months: number) {
    const now = today()
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1))
  }

  async function generatedInvoices(recurringInvoiceId: string) {
    return prisma.invoice.findMany({
      where: { recurringInvoiceId },
      orderBy: { recurringRunDate: "asc" },
      include: { items: true },
    })
  }

  /** Ticks scoped to the test's organization, so parallel tests never act on each other's data. */
  const tickRecurring = (org: { organizationId: string }, now = new Date()) =>
    runRecurringTick(now, { organizationIds: [org.organizationId] })

  /** The recurring task followed by the tick's job sweep, which sends auto-sent invoices. */
  const tickRecurringAndSend = async (org: { organizationId: string }, now = new Date()) => {
    const result = await tickRecurring(org, now)
    await runOrganizationJobs([org.organizationId], now)
    return result
  }

  it("generates a draft for a due run and advances the schedule", async () => {
    const { org, contactId } = await setup()
    const schedule = await createSchedule(org.actors.admin, contactId)
    expect(schedule).toMatchObject({ status: "active", nextRunAt: today() })

    await tickRecurring(org)

    const invoices = await generatedInvoices(schedule.id)
    expect(invoices).toHaveLength(1)
    expect(invoices[0]).toMatchObject({
      status: "draft",
      contactId,
      recurringRunDate: today(),
      dueDate: addUtcDays(today(), 14),
      currency: "USD",
    })
    expect(invoices[0]?.totalGross.toNumber()).toBe(1250)
    expect(invoices[0]?.items[0]?.description).toBe("Retainer")

    const after = await prisma.recurringInvoice.findUniqueOrThrow({ where: { id: schedule.id } })
    expect(after.nextRunAt).toEqual(advanceRunDate(today(), 1, "month", today().getUTCDate()))
    expect(after.lastRunAt).toEqual(today())

    const activity = await readActivity({ organizationId: org.organizationId, aggregateType: "recurring" })
    expect(activity.events.map((event) => event.type)).toEqual([
      "recurring.created",
      "recurring.invoice_generated",
    ])
    expect(activity.events[1]?.actor).toMatchObject({ kind: "system", label: "Recurring invoices" })
  })

  it("never duplicates a run under overlapping or repeated ticks", async () => {
    const { org, contactId } = await setup()
    const schedule = await createSchedule(org.actors.admin, contactId)
    await backdate(schedule.id, monthsAgo(2))

    const now = new Date()
    const scope = { organizationIds: [org.organizationId] }
    await Promise.all([runRecurringTick(now, scope), runRecurringTick(now, scope), runSchedulerTick(now, scope)])
    await runRecurringTick(now, scope)

    const invoices = await generatedInvoices(schedule.id)
    expect(invoices.map((invoice) => invoice.recurringRunDate)).toEqual([
      monthsAgo(2),
      monthsAgo(1),
      monthsAgo(0),
    ])

    // Replaying the scheduler's idempotency key returns the original outcome.
    const actor = recurringSystemActor(org.organizationId)
    const replay = await executeCommand(
      generateRecurringRun,
      { id: schedule.id, runDate: monthsAgo(2).toISOString() },
      { actor, clientRequestId: runRequestId(schedule.id, monthsAgo(2)) }
    )
    expect(replay).toMatchObject({ status: "completed", result: { invoice: { id: invoices[0]?.id } } })

    // A fresh key for an already generated run is refused rather than duplicated.
    const fresh = await executeCommand(
      generateRecurringRun,
      { id: schedule.id, runDate: monthsAgo(2).toISOString() },
      { actor, clientRequestId: "other-key" }
    )
    expect(fresh.status === "failed" && fresh.error.code).toBe("run_not_due")
    expect(await generatedInvoices(schedule.id)).toHaveLength(3)
  })

  it("catches up missed runs in order, bounded per tick", async () => {
    const { org, contactId } = await setup()
    const schedule = await createSchedule(org.actors.admin, contactId, { intervalUnit: "week" })
    const start = addUtcDays(today(), -7 * 15)
    await backdate(schedule.id, start)

    await tickRecurring(org)
    let invoices = await generatedInvoices(schedule.id)
    expect(invoices).toHaveLength(12)

    await tickRecurring(org)
    invoices = await generatedInvoices(schedule.id)
    expect(invoices).toHaveLength(16)
    expect(invoices.map((invoice) => invoice.recurringRunDate)).toEqual(
      Array.from({ length: 16 }, (_, index) => addUtcDays(start, index * 7))
    )
    // Numbers are allocated in run order.
    const numbers = invoices.map((invoice) => invoice.number)
    expect([...numbers].sort()).toEqual(numbers)
  })

  it("ends a schedule after its remaining runs", async () => {
    const { org, contactId } = await setup()
    const schedule = await createSchedule(org.actors.admin, contactId, {
      end: { type: "after_runs", runs: 2 },
    })
    await backdate(schedule.id, monthsAgo(3))

    await tickRecurring(org)

    expect(await generatedInvoices(schedule.id)).toHaveLength(2)
    const after = await prisma.recurringInvoice.findUniqueOrThrow({ where: { id: schedule.id } })
    expect(after).toMatchObject({ status: "ended", remainingRuns: 0 })
  })

  it("ends a schedule once its end date has passed", async () => {
    const { org, contactId } = await setup()
    const schedule = await createSchedule(org.actors.admin, contactId)
    await backdate(schedule.id, monthsAgo(3), { endsAt: monthsAgo(2) })

    await tickRecurring(org)

    const invoices = await generatedInvoices(schedule.id)
    expect(invoices.map((invoice) => invoice.recurringRunDate)).toEqual([monthsAgo(3), monthsAgo(2)])
    const after = await prisma.recurringInvoice.findUniqueOrThrow({ where: { id: schedule.id } })
    expect(after.status).toBe("ended")
  })

  it("sends generated invoices when the schedule auto-sends", async () => {
    enableEmail()
    const { org, contactId } = await setup()
    const schedule = await createSchedule(org.actors.admin, contactId, { autoSend: true })

    await tickRecurringAndSend(org)

    const [invoice] = await generatedInvoices(schedule.id)
    expect(invoice).toMatchObject({ status: "sent", lastEmailAttemptOutcome: "sent" })
    expect(sendInvoiceEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "billing@acme.test" }),
        expect.objectContaining({ idempotencyScope: expect.stringMatching(/^invoice-send:/) }))
  })

  it("queues auto-sends for the job sweep instead of sending while generating runs", async () => {
    enableEmail()
    const { org, contactId } = await setup()
    const schedule = await createSchedule(org.actors.admin, contactId, { autoSend: true })

    await tickRecurring(org)

    const [invoice] = await generatedInvoices(schedule.id)
    expect(invoice?.status).toBe("draft")
    expect(sendInvoiceEmail).not.toHaveBeenCalled()
    expect(
      await prisma.job.findUniqueOrThrow({ where: { dedupeKey: `recurring-auto-send:${invoice?.id}` } })
    ).toMatchObject({ type: "recurring.auto_send", status: "pending", attempts: 0 })

    await runOrganizationJobs([org.organizationId])
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice!.id } })).status).toBe("sent")
  })

  it("keeps the draft and records why when auto-send fails", async () => {
    enableEmail()
    const { org, contactId } = await setup({ contactEmail: null })
    const schedule = await createSchedule(org.actors.admin, contactId, { autoSend: true })

    await tickRecurringAndSend(org)

    const [invoice] = await generatedInvoices(schedule.id)
    expect(invoice).toMatchObject({
      status: "draft",
      lastEmailAttemptOutcome: "failed",
      lastEmailAttemptCode: "missing_recipient",
    })
    expect(sendInvoiceEmail).not.toHaveBeenCalled()
    const activity = await readActivity({ organizationId: org.organizationId, aggregateType: "recurring" })
    expect(activity.events.map((event) => event.type)).toContain("recurring.auto_send_failed")
    // The schedule keeps running; only the one invoice needs attention.
    const after = await prisma.recurringInvoice.findUniqueOrThrow({ where: { id: schedule.id } })
    expect(after.status).toBe("active")
  })

  it("keeps the draft and retries later when the email provider fails", async () => {
    enableEmail()
    vi.mocked(sendInvoiceEmail).mockRejectedValue(new Error("provider down"))
    const { org, contactId } = await setup()
    const schedule = await createSchedule(org.actors.admin, contactId, { autoSend: true })

    await tickRecurringAndSend(org)

    const [invoice] = await generatedInvoices(schedule.id)
    expect(invoice?.status).toBe("draft")
    const job = await prisma.job.findFirstOrThrow({ where: { organizationId: org.organizationId } })
    expect(job).toMatchObject({ type: "recurring.auto_send", status: "pending", attempts: 1 })
  })

  it("pauses a schedule whose run fails and retries it after resume", async () => {
    const { org, contactId } = await setup()
    const schedule = await createSchedule(org.actors.admin, contactId)
    await prisma.recurringInvoice.update({ where: { id: schedule.id }, data: { items: [{ bad: true }] } })

    const result = await tickRecurring(org)
    expect(result.failed).toBeGreaterThanOrEqual(1)
    let after = await prisma.recurringInvoice.findUniqueOrThrow({ where: { id: schedule.id } })
    expect(after.status).toBe("paused")
    const activity = await readActivity({ organizationId: org.organizationId, aggregateType: "recurring" })
    expect(activity.events.map((event) => event.type)).toContain("recurring.run_failed")

    await executeCommand(
      updateRecurringInvoice,
      { id: schedule.id, items: [{ description: "Fixed", quantity: 1, unitPrice: 10 }] },
      { actor: org.actors.admin }
    )
    const resumed = await executeCommand(resumeRecurringInvoice, { id: schedule.id }, { actor: org.actors.admin })
    expect(resumed).toMatchObject({ status: "completed", result: { status: "active", nextRunAt: today() } })

    await tickRecurring(org)
    after = await prisma.recurringInvoice.findUniqueOrThrow({ where: { id: schedule.id } })
    expect(after.status).toBe("active")
    expect(await generatedInvoices(schedule.id)).toHaveLength(1)
  })

  it("does not back-bill a paused period when resumed", async () => {
    const { org, contactId } = await setup()
    const schedule = await createSchedule(org.actors.admin, contactId)
    await backdate(schedule.id, monthsAgo(3), { status: "paused" })

    const resumed = await executeCommand(resumeRecurringInvoice, { id: schedule.id }, { actor: org.actors.admin })
    if (resumed.status !== "completed") throw new Error("resume failed")
    expect(resumed.result.nextRunAt.getTime()).toBeGreaterThanOrEqual(today().getTime())
  })

  it("generates the next run immediately on request", async () => {
    const { org, contactId } = await setup()
    const start = addUtcDays(today(), 10)
    const schedule = await createSchedule(org.actors.admin, contactId, {
      startDate: formatCalendarDate(start),
    })

    const outcome = await executeCommand(runRecurringInvoiceNow, { id: schedule.id }, { actor: org.actors.admin })
    expect(outcome).toMatchObject({ status: "completed", result: { runDate: start } })

    const after = await prisma.recurringInvoice.findUniqueOrThrow({ where: { id: schedule.id } })
    expect(after.nextRunAt).toEqual(advanceRunDate(start, 1, "month", start.getUTCDate()))
    expect(await generatedInvoices(schedule.id)).toHaveLength(1)
  })

  it("pauses, ends, and refuses to resume ended schedules", async () => {
    const { org, contactId } = await setup()
    const schedule = await createSchedule(org.actors.admin, contactId)
    const actor = org.actors.admin

    expect(
      await executeCommand(setRecurringInvoiceStatus, { id: schedule.id, status: "paused" }, { actor })
    ).toMatchObject({ status: "completed", result: { status: "paused" } })
    await tickRecurring(org)
    expect(await generatedInvoices(schedule.id)).toHaveLength(0)

    await executeCommand(setRecurringInvoiceStatus, { id: schedule.id, status: "ended" }, { actor })
    const resumed = await executeCommand(resumeRecurringInvoice, { id: schedule.id }, { actor })
    expect(resumed.status === "failed" && resumed.error.code).toBe("schedule_ended")
  })

  it("recalculates the next run when the cadence changes", async () => {
    const { org, contactId } = await setup()
    const start = addUtcDays(today(), 3)
    const schedule = await createSchedule(org.actors.admin, contactId, { startDate: formatCalendarDate(start) })

    const updated = await executeCommand(
      updateRecurringInvoice,
      { id: schedule.id, intervalUnit: "week", startDate: formatCalendarDate(addUtcDays(today(), -1)) },
      { actor: org.actors.admin }
    )
    expect(updated).toMatchObject({ status: "completed", result: { nextRunAt: addUtcDays(today(), 6) } })
  })

  it("never overwrites progress committed by a concurrent run when the schedule is edited", async () => {
    const { org, contactId } = await setup()
    const schedule = await createSchedule(org.actors.admin, contactId, {
      end: { type: "after_runs", runs: 3 },
    })
    const advanced = advanceRunDate(today(), 1, "month", today().getUTCDate())

    // Stands in for a run that holds the schedule while it generates and advances it.
    let progressWritten!: () => void
    const written = new Promise<void>((resolve) => (progressWritten = resolve))
    const run = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "recurring_invoice" WHERE "id" = ${schedule.id} FOR UPDATE`
      await tx.recurringInvoice.update({
        where: { id: schedule.id },
        data: { nextRunAt: advanced, remainingRuns: 2, lastRunAt: today() },
      })
      progressWritten()
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    await written

    const [edited] = await Promise.all([
      executeCommand(updateRecurringInvoice, { id: schedule.id, name: "Renamed" }, { actor: org.actors.admin }),
      run,
    ])
    expect(edited.status).toBe("completed")

    const after = await prisma.recurringInvoice.findUniqueOrThrow({ where: { id: schedule.id } })
    expect(after).toMatchObject({ name: "Renamed", nextRunAt: advanced, remainingRuns: 2, lastRunAt: today() })
  })

  it("enforces role permissions", async () => {
    const { org, contactId } = await setup({ roles: ["admin", "member", "accountant"] })

    const denied = await executeCommand(createRecurringInvoice, scheduleInput(contactId), {
      actor: org.actors.accountant,
    })
    expect(denied.status === "failed" && denied.error.tag).toBe("Forbidden")

    const allowed = await executeCommand(createRecurringInvoice, scheduleInput(contactId), {
      actor: org.actors.member,
    })
    expect(allowed.status).toBe("completed")
  })

  describe("agents in approval mode", () => {
    async function approvalAgent(org: Awaited<ReturnType<typeof setup>>["org"]): Promise<AgentActor> {
      const { secret } = await createAgentKey(org.actors.admin, {
        name: "Bookkeeper",
        mode: "approval_required",
        scopes: ["recurring:create", "recurring:update", "recurring:read"],
      })
      return authenticateAgentSecret(secret)
    }

    it("creates auto-sending schedules paused and queues their activation", async () => {
      const { org, contactId } = await setup()
      const agent = await approvalAgent(org)

      const draftOnly = await createSchedule(agent, contactId)
      expect(draftOnly.status).toBe("active")

      const autoSending = await createSchedule(agent, contactId, { autoSend: true })
      expect(autoSending.status).toBe("paused")

      const activation = await executeCommand(
        resumeRecurringInvoice,
        { id: autoSending.id },
        { actor: agent, clientRequestId: "activate-1" }
      )
      expect(activation.status).toBe("awaiting_approval")
      const runNow = await executeCommand(
        runRecurringInvoiceNow,
        { id: autoSending.id },
        { actor: agent, clientRequestId: "run-1" }
      )
      expect(runNow.status).toBe("awaiting_approval")

      const pause = await executeCommand(
        setRecurringInvoiceStatus,
        { id: draftOnly.id, status: "paused" },
        { actor: agent, clientRequestId: "pause-1" }
      )
      expect(pause).toMatchObject({ status: "completed", result: { status: "paused" } })

      if (activation.status !== "awaiting_approval") throw new Error("expected approval")
      const approved = await executeCommand(
        resumeRecurringInvoice,
        { id: autoSending.id },
        { actor: agent, approvedByUserId: org.actors.admin.userId, resumeReceiptId: activation.commandId }
      )
      expect(approved).toMatchObject({ status: "completed", result: { status: "active" } })
    })

    it("pauses an active auto-sending schedule when the agent edits it", async () => {
      const { org, contactId } = await setup()
      const agent = await approvalAgent(org)
      const schedule = await createSchedule(org.actors.admin, contactId, { autoSend: true })
      expect(schedule.status).toBe("active")

      const edited = await executeCommand(
        updateRecurringInvoice,
        { id: schedule.id, items: [{ description: "Bigger retainer", quantity: 1, unitPrice: 5000 }] },
        { actor: agent, clientRequestId: "edit-1" }
      )
      expect(edited).toMatchObject({ status: "completed", result: { status: "paused" } })
    })
  })
})
