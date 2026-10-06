import "dotenv/config"
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../lib/emails/reminder-email", async () => {
  const actual = await vi.importActual<typeof import("../../lib/emails/reminder-email")>(
    "../../lib/emails/reminder-email"
  )
  return { ...actual, sendReminderEmail: vi.fn().mockResolvedValue({ id: "email_reminder" }) }
})

import { prisma } from "../../lib/db"
import { sendReminderEmail } from "../../lib/emails/reminder-email"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import {
  SUPERSEDED_MESSAGE,
  planDueReminders,
  sendReminderNow,
  setInvoiceRemindersPaused,
  updateReminderPolicy,
} from "../commands/reminders"
import { executeCommand } from "../execute"
import { runOverdueTask } from "../features/overdue"
import { handleReminderSendJob, runReminderTask } from "../features/reminders"
import { runJobsNow } from "../jobs"
import { appRouter } from "../../trpc/router"

const DAY = 24 * 60 * 60 * 1000
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY)
const describeIfDatabase = hasTestDatabase ? describe : describe.skip
const sendMock = vi.mocked(sendReminderEmail)

function sendsTo(email: string) {
  return sendMock.mock.calls.filter(([params]) => params.to === email).length
}

describe("planDueReminders", () => {
  const dueDate = new Date("2026-06-01T00:00:00Z")
  const issueDate = new Date("2026-05-01T00:00:00Z")

  it("sends only the most recent due offset and skips the backlog", () => {
    const plan = planDueReminders({
      dueDate,
      issueDate,
      now: new Date("2026-06-20T00:00:00Z"),
      offsetsDays: [-3, 7, 14],
      existing: [],
    })
    expect(plan.send?.offsetDays).toBe(14)
    expect(plan.skip.map((slot) => slot.offsetDays)).toEqual([-3, 7])
  })

  it("never plans offsets before the issue date or already reserved", () => {
    const plan = planDueReminders({
      dueDate,
      issueDate: new Date("2026-05-30T00:00:00Z"),
      now: new Date("2026-06-09T00:00:00Z"),
      offsetsDays: [-3, 7],
      existing: [],
    })
    expect(plan).toEqual({ send: { offsetDays: 7, scheduledFor: new Date("2026-06-08T00:00:00Z") }, skip: [] })

    const repeat = planDueReminders({
      dueDate,
      issueDate,
      now: new Date("2026-06-09T00:00:00Z"),
      offsetsDays: [7],
      existing: [{ offsetDays: 7, scheduledFor: new Date("2026-06-08T00:00:00Z") }],
    })
    expect(repeat).toEqual({ send: null, skip: [] })
  })

  it("skips due offsets older than a reminder that already went out", () => {
    const plan = planDueReminders({
      dueDate,
      issueDate,
      now: new Date("2026-06-12T00:00:00Z"),
      offsetsDays: [7],
      existing: [{ offsetDays: 10, scheduledFor: new Date("2026-06-11T09:00:00Z") }],
    })
    expect(plan.send).toBeNull()
    expect(plan.skip.map((slot) => slot.offsetDays)).toEqual([7])
  })
})

describeIfDatabase("overdue and reminders", () => {
  const cleanups: Array<() => Promise<void>> = []
  const previousEnv = { RESEND_API_KEY: process.env.RESEND_API_KEY, FROM_EMAIL: process.env.FROM_EMAIL }

  beforeAll(() => {
    process.env.RESEND_API_KEY = "re_test"
    process.env.FROM_EMAIL = "noreply@example.com"
  })
  afterAll(() => {
    process.env.RESEND_API_KEY = previousEnv.RESEND_API_KEY
    process.env.FROM_EMAIL = previousEnv.FROM_EMAIL
  })
  beforeEach(() => {
    sendMock.mockReset()
    sendMock.mockResolvedValue({ id: "email_reminder" })
    process.env.RESEND_API_KEY = "re_test"
  })
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function setup(options: { policy?: { enabled: boolean; offsetsDays: number[] }; email?: string | null } = {}) {
    const org = await createTestOrganization({ roles: ["admin", "member", "accountant"] })
    cleanups.push(org.cleanup)
    const email = options.email === undefined ? `customer-${randomUUID().slice(0, 8)}@example.com` : options.email
    const contact = await prisma.contact.create({
      data: { organizationId: org.organizationId, name: "Acme", email },
    })
    if (options.policy) {
      const outcome = await executeCommand(updateReminderPolicy, options.policy, { actor: org.actors.admin })
      expect(outcome.status).toBe("completed")
    }
    return { org, contactId: contact.id, email: email ?? "" }
  }

  async function createInvoice(
    context: { org: { organizationId: string }; contactId: string },
    input: {
      issuedDaysAgo: number
      dueInDays: number
      status?: string
      total?: number
      amountPaid?: number
      amountCredited?: number
      remindersPaused?: boolean
    }
  ) {
    const total = input.total ?? 100
    return prisma.invoice.create({
      data: {
        organizationId: context.org.organizationId,
        contactId: context.contactId,
        number: `INV-${randomUUID().slice(0, 8)}`,
        status: input.status ?? "sent",
        issueDate: daysFromNow(-input.issuedDaysAgo),
        dueDate: daysFromNow(input.dueInDays),
        subtotalNet: total,
        totalGross: total,
        amountPaid: input.amountPaid ?? 0,
        amountCredited: input.amountCredited ?? 0,
        remindersPaused: input.remindersPaused ?? false,
      },
    })
  }

  const eventsOf = (organizationId: string, type: string) =>
    prisma.domainEvent.findMany({ where: { organizationId, type }, orderBy: { sequence: "asc" } })

  it("marks past-due invoices with a balance overdue once, through audited commands", async () => {
    const context = await setup()
    const sent = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -1 })
    const viewed = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -2, status: "viewed" })
    const notDue = await createInvoice(context, { issuedDaysAgo: 1, dueInDays: 5 })
    const settled = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -1, amountPaid: 100 })
    const draft = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -1, status: "draft" })

    await runOverdueTask()
    await runOverdueTask()

    const statuses = Object.fromEntries(
      (
        await prisma.invoice.findMany({
          where: { organizationId: context.org.organizationId },
          select: { id: true, status: true },
        })
      ).map((invoice) => [invoice.id, invoice.status])
    )
    expect(statuses).toEqual({
      [sent.id]: "overdue",
      [viewed.id]: "overdue",
      [notDue.id]: "sent",
      [settled.id]: "sent",
      [draft.id]: "draft",
    })

    const events = await eventsOf(context.org.organizationId, "invoice.became_overdue")
    expect(events.map((event) => event.aggregateId).sort()).toEqual([sent.id, viewed.id].sort())
    expect(events.every((event) => event.actorKind === "system")).toBe(true)
  })

  it("sends a due reminder exactly once across repeated ticks", async () => {
    const context = await setup({ policy: { enabled: true, offsetsDays: [7, -3, 14] } })
    const invoice = await createInvoice(context, { issuedDaysAgo: 20, dueInDays: 2 })

    await runReminderTask()
    await runReminderTask()

    expect(sendsTo(context.email)).toBe(1)
    const [params] = sendMock.mock.calls.find(([call]) => call.to === context.email) ?? []
    expect(params).toMatchObject({ stage: "upcoming", invoice: { number: invoice.number, balanceDue: 100 } })

    const reminders = await prisma.invoiceReminder.findMany({ where: { invoiceId: invoice.id } })
    expect(reminders).toHaveLength(1)
    expect(reminders[0]).toMatchObject({ offsetDays: -3, outcome: "sent" })
    expect(reminders[0]?.sentAt).toBeInstanceOf(Date)
    expect(await eventsOf(context.org.organizationId, "invoice.reminder_sent")).toHaveLength(1)
  })

  it("sends only the latest reminder when several are already due", async () => {
    const context = await setup({ policy: { enabled: true, offsetsDays: [-3, 7, 14] } })
    const invoice = await createInvoice(context, { issuedDaysAgo: 40, dueInDays: -20, status: "overdue" })

    await runReminderTask()

    expect(sendsTo(context.email)).toBe(1)
    expect(sendMock.mock.calls.find(([call]) => call.to === context.email)?.[0].stage).toBe("overdue")
    const reminders = await prisma.invoiceReminder.findMany({
      where: { invoiceId: invoice.id },
      orderBy: { offsetDays: "asc" },
    })
    expect(reminders.map((reminder) => [reminder.offsetDays, reminder.outcome, reminder.outcomeMessage])).toEqual([
      [-3, "skipped", SUPERSEDED_MESSAGE],
      [7, "skipped", SUPERSEDED_MESSAGE],
      [14, "sent", null],
    ])
  })

  it("never reminds paused, paid, credited, unreachable, or not-yet-issued offsets", async () => {
    const context = await setup({ policy: { enabled: true, offsetsDays: [-3, 7] } })
    const invoices = await Promise.all([
      createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10, remindersPaused: true }),
      createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10, status: "paid", amountPaid: 100 }),
      createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10, status: "credited", amountCredited: 100 }),
      createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10, amountCredited: 40, amountPaid: 60 }),
      createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10, status: "draft" }),
      // Issued after its -3 reminder date: that reminder must never go out.
      createInvoice(context, { issuedDaysAgo: 0.5, dueInDays: 2 }),
    ])
    const noEmail = await setup({ policy: { enabled: true, offsetsDays: [7] }, email: null })
    const unreachable = await createInvoice(noEmail, { issuedDaysAgo: 30, dueInDays: -10 })

    await runReminderTask()

    expect(sendsTo(context.email)).toBe(0)
    expect(
      await prisma.invoiceReminder.count({
        where: { invoiceId: { in: [...invoices.map((invoice) => invoice.id), unreachable.id] } },
      })
    ).toBe(0)
  })

  it("does nothing for organizations with reminders disabled", async () => {
    const context = await setup({ policy: { enabled: false, offsetsDays: [7] } })
    const invoice = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10 })

    await runReminderTask()

    expect(await prisma.invoiceReminder.count({ where: { invoiceId: invoice.id } })).toBe(0)
  })

  it("records a failed delivery and retries the job without sending twice", async () => {
    const context = await setup({ policy: { enabled: true, offsetsDays: [7] } })
    const invoice = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10, status: "overdue" })
    sendMock.mockRejectedValueOnce(new Error("provider down"))

    await runReminderTask()

    const reminder = await prisma.invoiceReminder.findUniqueOrThrow({
      where: { invoiceId_offsetDays: { invoiceId: invoice.id, offsetDays: 7 } },
    })
    expect(reminder.outcome).toBe("failed")
    const job = await prisma.job.findUniqueOrThrow({ where: { dedupeKey: `reminder:${reminder.id}` } })
    expect(job).toMatchObject({ status: "pending", attempts: 1 })

    await runJobsNow([job.id], daysFromNow(1))
    await runJobsNow([job.id], daysFromNow(2))
    await handleReminderSendJob({ organizationId: context.org.organizationId, payload: { reminderId: reminder.id } })
    await runReminderTask()

    expect(sendsTo(context.email)).toBe(2)
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "done" })
    expect(
      await prisma.invoiceReminder.findUniqueOrThrow({ where: { id: reminder.id } })
    ).toMatchObject({ outcome: "sent", outcomeMessage: null })
    expect(await eventsOf(context.org.organizationId, "invoice.reminder_sent")).toHaveLength(1)
  })

  it("marks reminders skipped at send time when email delivery is unavailable", async () => {
    const context = await setup({ policy: { enabled: true, offsetsDays: [7] } })
    const invoice = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10 })
    delete process.env.RESEND_API_KEY

    await runReminderTask()

    expect(sendsTo(context.email)).toBe(0)
    expect(
      await prisma.invoiceReminder.findUniqueOrThrow({
        where: { invoiceId_offsetDays: { invoiceId: invoice.id, offsetDays: 7 } },
      })
    ).toMatchObject({ outcome: "skipped", outcomeMessage: "Email delivery is not configured" })
  })

  it("skips a retried reminder once the invoice is paused", async () => {
    const context = await setup({ policy: { enabled: true, offsetsDays: [7] } })
    const invoice = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10 })
    sendMock.mockRejectedValueOnce(new Error("provider down"))
    await runReminderTask()

    await executeCommand(
      setInvoiceRemindersPaused,
      { invoiceId: invoice.id, paused: true },
      { actor: context.org.actors.admin }
    )
    const reminder = await prisma.invoiceReminder.findFirstOrThrow({ where: { invoiceId: invoice.id } })
    const job = await prisma.job.findUniqueOrThrow({ where: { dedupeKey: `reminder:${reminder.id}` } })
    await runJobsNow([job.id], daysFromNow(1))

    expect(await prisma.invoiceReminder.findUniqueOrThrow({ where: { id: reminder.id } })).toMatchObject({
      outcome: "skipped",
      outcomeMessage: "Reminders are paused for this invoice",
    })
    expect(sendsTo(context.email)).toBe(1)
  })

  it("pauses reminders per invoice and sends manual reminders once per day", async () => {
    const context = await setup()
    const invoice = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -5, status: "overdue" })
    const paid = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -5, status: "paid", amountPaid: 100 })

    const paused = await executeCommand(
      setInvoiceRemindersPaused,
      { invoiceId: invoice.id, paused: true },
      { actor: context.org.actors.member }
    )
    expect(paused).toMatchObject({ status: "completed", result: { remindersPaused: true } })
    expect(await eventsOf(context.org.organizationId, "invoice.reminders_paused")).toHaveLength(1)

    const manual = await executeCommand(sendReminderNow, { invoiceId: invoice.id }, { actor: context.org.actors.member })
    expect(manual.status).toBe("completed")
    expect(sendsTo(context.email)).toBe(1)
    expect(await prisma.invoiceReminder.findMany({ where: { invoiceId: invoice.id } })).toMatchObject([
      { offsetDays: 5, outcome: "sent" },
    ])

    const again = await executeCommand(sendReminderNow, { invoiceId: invoice.id }, { actor: context.org.actors.member })
    expect(again).toMatchObject({ status: "failed", error: { code: "already_reminded" } })

    const settled = await executeCommand(sendReminderNow, { invoiceId: paid.id }, { actor: context.org.actors.admin })
    expect(settled).toMatchObject({ status: "failed", error: { code: "not_remindable" } })

    const forbidden = await executeCommand(
      sendReminderNow,
      { invoiceId: invoice.id },
      { actor: context.org.actors.accountant }
    )
    expect(forbidden).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
    expect(sendsTo(context.email)).toBe(1)
  })

  it("validates and stores the reminder policy", async () => {
    const context = await setup()
    const actor = context.org.actors.admin

    const invalid = await executeCommand(updateReminderPolicy, { enabled: true, offsetsDays: [7, 7] }, { actor })
    expect(invalid).toMatchObject({ status: "failed", error: { tag: "ValidationFailed" } })
    const outOfRange = await executeCommand(updateReminderPolicy, { enabled: true, offsetsDays: [120] }, { actor })
    expect(outOfRange).toMatchObject({ status: "failed", error: { tag: "ValidationFailed" } })

    const member = await executeCommand(
      updateReminderPolicy,
      { enabled: true, offsetsDays: [7] },
      { actor: context.org.actors.member }
    )
    expect(member).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })

    const saved = await executeCommand(updateReminderPolicy, { enabled: true, offsetsDays: [14, -3] }, { actor })
    expect(saved).toMatchObject({ status: "completed", result: { enabled: true, offsetsDays: [-3, 14] } })
    const settings = await prisma.orgSettings.findUniqueOrThrow({
      where: { organizationId: context.org.organizationId },
    })
    expect(settings.reminderPolicy).toEqual({ enabled: true, offsetsDays: [-3, 14] })
  })

  it("lists reminder history with upcoming policy reminders for the invoice page", async () => {
    const context = await setup({ policy: { enabled: true, offsetsDays: [-3, 7] } })
    const invoice = await createInvoice(context, { issuedDaysAgo: 20, dueInDays: 1 })
    await runReminderTask()

    const caller = appRouter.createCaller({
      session: {
        user: { id: context.org.actors.admin.userId, email: "admin@example.com", name: "Admin" },
        session: { activeOrganizationId: context.org.organizationId },
      },
    } as never)
    const listing = await caller.reminders.listForInvoice({ invoiceId: invoice.id })

    expect(listing).toMatchObject({ policyEnabled: true, remindable: true, hasRecipient: true, remindersPaused: false })
    expect(listing.reminders.map((reminder) => [reminder.offsetDays, reminder.status])).toEqual([
      [-3, "sent"],
      [7, "upcoming"],
    ])
    expect(await caller.reminders.getPolicy()).toEqual({ enabled: true, offsetsDays: [-3, 7] })
  })
})
