import "dotenv/config"
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../lib/email", async () => {
  const actual = await vi.importActual<typeof import("../../lib/email")>("../../lib/email")
  return { ...actual, deliver: vi.fn().mockResolvedValue({ id: "email_reminder" }) }
})

import { prisma } from "../../lib/db"
import { formatCurrency } from "../../lib/i18n/format"
import { deliver, EmailSendError } from "../../lib/email"
import { findEmailDeliveryJobs, retryEmailDeliveries } from "../../test-utils/email-outbox"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import {
  OFFSET_REMOVED_MESSAGE,
  POLICY_DISABLED_MESSAGE,
  REMINDER_BATCH_SIZE,
  SUPERSEDED_MESSAGE,
  manualReminderIdempotencyKey,
  pauseInvoiceReminders,
  planDueReminders,
  resumeInvoiceReminders,
  sendReminderNow,
  updateReminderPolicy,
} from "../commands/reminders"
import { authenticateAgentSecret, createAgentKey } from "../agent-keys"
import { decideApproval } from "../approvals"
import { executeCommand } from "../execute"
import { OVERDUE_BATCH_SIZE, runOverdueTask } from "../features/overdue"
import { handleReminderSendJob, runReminderTask } from "../features/reminders"
import { runJobsNow } from "../jobs"
import { runOrganizationJobs } from "../scheduler"
import { appRouter } from "../../trpc/router"

const DAY = 24 * 60 * 60 * 1000
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY)
const describeIfDatabase = hasTestDatabase ? describe : describe.skip
const sendMock = vi.mocked(deliver)

function sendsTo(email: string) {
  return sendMock.mock.calls.filter(([message]) => message.to === email).length
}

function callsTo(email: string) {
  return sendMock.mock.calls.filter(([message]) => message.to === email)
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

  type Context = { org: { organizationId: string } }

  /** One reminders tick plus the job sweep, scoped to the test's organizations. */
  async function remindersTick(...contexts: Context[]) {
    const organizationIds = contexts.map((context) => context.org.organizationId)
    const now = new Date()
    const result = await runReminderTask(now, { organizationIds })
    await runOrganizationJobs(organizationIds, now)
    return result
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

    const organizationIds = [context.org.organizationId]
    await runOverdueTask(new Date(), { organizationIds })
    await runOverdueTask(new Date(), { organizationIds })

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

    await remindersTick(context)
    await remindersTick(context)

    expect(sendsTo(context.email)).toBe(1)
    const [[message, options]] = callsTo(context.email)
    // The upcoming-stage reminder, naming the invoice and its balance.
    expect(message.subject).toMatch(new RegExp(`^Reminder: invoice ${invoice.number} is due`))
    expect(message.html).toContain(formatCurrency(100, invoice.currency, "en-US"))
    expect(options?.idempotencyKey).toMatch(/^yaip-reminder-/)

    const reminders = await prisma.invoiceReminder.findMany({ where: { invoiceId: invoice.id } })
    expect(reminders).toHaveLength(1)
    expect(reminders[0]).toMatchObject({ offsetDays: -3, outcome: "sent" })
    expect(reminders[0]?.sentAt).toBeInstanceOf(Date)
    expect(await eventsOf(context.org.organizationId, "invoice.reminder_sent")).toHaveLength(1)
  })

  it("sends only the latest reminder when several are already due", async () => {
    const context = await setup({ policy: { enabled: true, offsetsDays: [-3, 7, 14] } })
    const invoice = await createInvoice(context, { issuedDaysAgo: 40, dueInDays: -20, status: "overdue" })

    await remindersTick(context)

    expect(sendsTo(context.email)).toBe(1)
    expect(callsTo(context.email)[0]?.[0].subject).toMatch(new RegExp(`^Overdue: invoice ${invoice.number}`))
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

    await remindersTick(context, noEmail)

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

    await remindersTick(context)

    expect(await prisma.invoiceReminder.count({ where: { invoiceId: invoice.id } })).toBe(0)
  })

  it("keeps a reminder sending after an uncertain failure and retries the same email", async () => {
    const context = await setup({ policy: { enabled: true, offsetsDays: [7] } })
    const invoice = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10, status: "overdue" })
    sendMock.mockRejectedValueOnce(new Error("provider down"))

    await remindersTick(context)

    const reminder = await prisma.invoiceReminder.findUniqueOrThrow({
      where: { invoiceId_offsetDays: { invoiceId: invoice.id, offsetDays: 7 } },
    })
    expect(reminder.outcome).toBe("sending")
    // The reminder job finished once the email was queued; the outbox retries the delivery.
    const job = await prisma.job.findUniqueOrThrow({ where: { dedupeKey: `reminder:${reminder.id}` } })
    expect(job).toMatchObject({ status: "done", attempts: 1 })
    const [delivery] = await findEmailDeliveryJobs(context.org.organizationId)
    expect(delivery).toMatchObject({ status: "pending", attempts: 1 })

    // Neither the reminder job nor another tick sends a second email while one is in flight.
    await handleReminderSendJob({ organizationId: context.org.organizationId, payload: { reminderId: reminder.id } })
    await remindersTick(context)
    expect(sendsTo(context.email)).toBe(1)

    await retryEmailDeliveries(context.org.organizationId)

    const calls = callsTo(context.email)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(calls[0])
    expect(
      await prisma.invoiceReminder.findUniqueOrThrow({ where: { id: reminder.id } })
    ).toMatchObject({ outcome: "sent", outcomeMessage: null })
    expect(await eventsOf(context.org.organizationId, "invoice.reminder_sent")).toHaveLength(1)
  })

  it("records a refused reminder as failed and never retries it", async () => {
    const context = await setup({ policy: { enabled: true, offsetsDays: [7] } })
    const invoice = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10, status: "overdue" })
    sendMock.mockRejectedValueOnce(new EmailSendError("validation_error", "Invalid recipient"))

    await remindersTick(context)

    const reminder = await prisma.invoiceReminder.findUniqueOrThrow({
      where: { invoiceId_offsetDays: { invoiceId: invoice.id, offsetDays: 7 } },
    })
    expect(reminder).toMatchObject({ outcome: "failed", outcomeMessage: "Email delivery failed: Invalid recipient" })
    expect(await eventsOf(context.org.organizationId, "invoice.reminder_failed")).toHaveLength(1)

    await handleReminderSendJob({ organizationId: context.org.organizationId, payload: { reminderId: reminder.id } })
    await remindersTick(context)
    await retryEmailDeliveries(context.org.organizationId)

    expect(sendsTo(context.email)).toBe(1)
    expect(await prisma.invoiceReminder.findUniqueOrThrow({ where: { id: reminder.id } })).toMatchObject({
      outcome: "failed",
    })
    expect(await eventsOf(context.org.organizationId, "invoice.reminder_sent")).toHaveLength(0)
  })

  it("marks reminders skipped at send time when email delivery is unavailable", async () => {
    const context = await setup({ policy: { enabled: true, offsetsDays: [7] } })
    const invoice = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10 })
    delete process.env.RESEND_API_KEY

    await remindersTick(context)

    expect(sendsTo(context.email)).toBe(0)
    expect(
      await prisma.invoiceReminder.findUniqueOrThrow({
        where: { invoiceId_offsetDays: { invoiceId: invoice.id, offsetDays: 7 } },
      })
    ).toMatchObject({ outcome: "skipped", outcomeMessage: "Email delivery is not configured" })
  })

  it("skips a queued reminder once the invoice is paused", async () => {
    const context = await setup({ policy: { enabled: true, offsetsDays: [7] } })
    const invoice = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10 })
    // Reserved by the reminders task; its job has not run yet.
    await runReminderTask(new Date(), { organizationIds: [context.org.organizationId] })

    await executeCommand(pauseInvoiceReminders, { invoiceId: invoice.id }, { actor: context.org.actors.admin })
    const reminder = await prisma.invoiceReminder.findFirstOrThrow({ where: { invoiceId: invoice.id } })
    const job = await prisma.job.findUniqueOrThrow({ where: { dedupeKey: `reminder:${reminder.id}` } })
    await runJobsNow([job.id])

    expect(await prisma.invoiceReminder.findUniqueOrThrow({ where: { id: reminder.id } })).toMatchObject({
      outcome: "skipped",
      outcomeMessage: "Reminders are paused for this invoice",
    })
    expect(sendsTo(context.email)).toBe(0)
    expect(await findEmailDeliveryJobs(context.org.organizationId)).toHaveLength(0)
  })

  it("pauses reminders per invoice and sends manual reminders once per day", async () => {
    const context = await setup()
    const invoice = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -5, status: "overdue" })
    const paid = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -5, status: "paid", amountPaid: 100 })

    const paused = await executeCommand(
      pauseInvoiceReminders,
      { invoiceId: invoice.id },
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
    await remindersTick(context)

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

  it("sends one manual reminder when two requests race", async () => {
    const context = await setup()
    const invoice = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -5, status: "overdue" })
    sendMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return { id: "email_reminder" }
    })

    const outcomes = await Promise.all([
      executeCommand(sendReminderNow, { invoiceId: invoice.id }, { actor: context.org.actors.member }),
      executeCommand(sendReminderNow, { invoiceId: invoice.id }, { actor: context.org.actors.admin }),
    ])

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["completed", "failed"])
    expect(outcomes.find((outcome) => outcome.status === "failed")).toMatchObject({
      error: { code: "already_reminded" },
    })
    expect(sendsTo(context.email)).toBe(1)
    const [reminder] = await prisma.invoiceReminder.findMany({ where: { invoiceId: invoice.id } })
    expect(reminder?.offsetDays).toBe(5)
    expect(callsTo(context.email)[0]?.[1]).toEqual({
      idempotencyKey: expect.stringMatching(new RegExp(`^${manualReminderIdempotencyKey(invoice.id, 5)}-\\d+$`)),
    })
  })

  it("records a refused manual reminder as failed and allows another manual reminder", async () => {
    const context = await setup()
    const invoice = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -5, status: "overdue" })
    sendMock.mockRejectedValueOnce(new EmailSendError("validation_error", "Invalid recipient"))

    const refused = await executeCommand(sendReminderNow, { invoiceId: invoice.id }, { actor: context.org.actors.admin })
    expect(refused.status).toBe("completed")
    expect(await prisma.invoiceReminder.findMany({ where: { invoiceId: invoice.id } })).toMatchObject([
      { offsetDays: 5, outcome: "failed", outcomeMessage: "Email delivery failed: Invalid recipient" },
    ])
    expect(await eventsOf(context.org.organizationId, "invoice.reminder_failed")).toHaveLength(1)

    const retried = await executeCommand(sendReminderNow, { invoiceId: invoice.id }, { actor: context.org.actors.admin })
    expect(retried.status).toBe("completed")
    expect(await prisma.invoiceReminder.findMany({ where: { invoiceId: invoice.id } })).toMatchObject([
      { offsetDays: 5, outcome: "sent" },
    ])
    // A new attempt is a new delivery, under its own provider key.
    const keys = callsTo(context.email).map(([, options]) => options?.idempotencyKey)
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
  })

  it("retries an uncertain manual reminder under its stored key and refuses another meanwhile", async () => {
    const context = await setup()
    const invoice = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -5, status: "overdue" })
    // The provider may have accepted the email; the response was lost.
    sendMock.mockRejectedValueOnce(new Error("connection reset after the provider accepted the email"))

    const first = await executeCommand(sendReminderNow, { invoiceId: invoice.id }, { actor: context.org.actors.admin })
    expect(first.status).toBe("completed")
    const [reminder] = await prisma.invoiceReminder.findMany({ where: { invoiceId: invoice.id } })
    expect(reminder).toMatchObject({ offsetDays: 5, outcome: "sending" })

    const again = await executeCommand(sendReminderNow, { invoiceId: invoice.id }, { actor: context.org.actors.admin })
    expect(again).toMatchObject({ status: "failed", error: { code: "already_reminded" } })

    await retryEmailDeliveries(context.org.organizationId)

    const calls = callsTo(context.email)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(calls[0])
    expect(calls[0]?.[1]?.idempotencyKey).toMatch(new RegExp(`^${manualReminderIdempotencyKey(invoice.id, 5)}-`))
    const settled = await prisma.invoiceReminder.findUniqueOrThrow({ where: { id: reminder!.id } })
    // Delivered, keeping the note of who sent it manually.
    expect(settled.outcome).toBe("sent")
    expect(settled.outcomeMessage).toBe(reminder!.outcomeMessage)
    const events = await eventsOf(context.org.organizationId, "invoice.reminder_sent")
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ manual: true, offsetDays: 5 })
    expect(events[0]?.actorKind).toBe("user")
  })

  it("skips an older reminder once a later policy offset is due, even before it is reserved", async () => {
    const context = await setup({ policy: { enabled: true, offsetsDays: [7, 14] } })
    const invoice = await createInvoice(context, { issuedDaysAgo: 40, dueInDays: -20, status: "overdue" })
    // Reserved on day 7; its job only runs now, on day 20, before any 14-day reminder exists.
    const older = await prisma.invoiceReminder.create({
      data: { invoiceId: invoice.id, offsetDays: 7, scheduledFor: daysFromNow(-13) },
    })

    await handleReminderSendJob({ organizationId: context.org.organizationId, payload: { reminderId: older.id } })

    expect(sendsTo(context.email)).toBe(0)
    expect(await prisma.invoiceReminder.findUniqueOrThrow({ where: { id: older.id } })).toMatchObject({
      outcome: "skipped",
      outcomeMessage: SUPERSEDED_MESSAGE,
    })
  })

  describe("pausing and resuming for agents in approval mode", () => {
    async function approvalAgent(organization: Awaited<ReturnType<typeof setup>>["org"], scopes: string[]) {
      const { secret } = await createAgentKey(organization.actors.admin, {
        name: "Collections",
        mode: "approval_required",
        scopes: scopes as never,
      })
      return authenticateAgentSecret(secret)
    }

    it("lets an update-only agent pause but never resume reminders", async () => {
      const context = await setup({ policy: { enabled: true, offsetsDays: [7] } })
      const invoice = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10, remindersPaused: false })
      const agent = await approvalAgent(context.org, ["invoice:read", "invoice:update"])

      const paused = await executeCommand(pauseInvoiceReminders, { invoiceId: invoice.id }, {
        actor: agent,
        clientRequestId: "pause-1",
      })
      expect(paused).toMatchObject({ status: "completed", result: { remindersPaused: true } })

      const resumed = await executeCommand(resumeInvoiceReminders, { invoiceId: invoice.id }, {
        actor: agent,
        clientRequestId: "resume-1",
      })
      expect(resumed).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).remindersPaused).toBe(true)
    })

    it("queues a resume for approval naming the recipient and the next reminder", async () => {
      const context = await setup({ policy: { enabled: true, offsetsDays: [7, 30] } })
      const invoice = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10, remindersPaused: true })
      const agent = await approvalAgent(context.org, ["invoice:read", "invoice:update", "invoice:send"])

      const queued = await executeCommand(resumeInvoiceReminders, { invoiceId: invoice.id }, {
        actor: agent,
        clientRequestId: "resume-queued",
      })
      if (queued.status !== "awaiting_approval") throw new Error(`expected approval, got ${queued.status}`)
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).remindersPaused).toBe(true)

      const request = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: queued.approvalRequestId } })
      expect(request.summary).toContain(invoice.number)
      expect(request.summary).toContain(context.email)
      expect(request.reviewContext).toMatchObject({
        details: {
          number: invoice.number,
          recipient: context.email,
          nextReminder: new Date().toISOString().slice(0, 10),
        },
      })

      const approved = await decideApproval({
        approvalRequestId: queued.approvalRequestId,
        decider: context.org.actors.admin,
        decision: "approve",
      })
      expect(approved.status).toBe("completed")
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).remindersPaused).toBe(false)
    })

    it("refuses an approved resume when the recipient changed after review", async () => {
      const context = await setup({ policy: { enabled: true, offsetsDays: [7] } })
      const invoice = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10, remindersPaused: true })
      const agent = await approvalAgent(context.org, ["invoice:read", "invoice:send"])

      const queued = await executeCommand(resumeInvoiceReminders, { invoiceId: invoice.id }, {
        actor: agent,
        clientRequestId: "resume-changed",
      })
      if (queued.status !== "awaiting_approval") throw new Error(`expected approval, got ${queued.status}`)
      await prisma.contact.update({ where: { id: context.contactId }, data: { email: "someone-else@example.com" } })

      const decided = await decideApproval({
        approvalRequestId: queued.approvalRequestId,
        decider: context.org.actors.admin,
        decision: "approve",
      })
      expect(decided).toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).remindersPaused).toBe(true)
    })
  })

  it("leaves sending to the job sweep instead of the scheduling task", async () => {
    const context = await setup({ policy: { enabled: true, offsetsDays: [7] } })
    const invoice = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10 })

    const result = await runReminderTask(new Date(), { organizationIds: [context.org.organizationId] })

    expect(result).toMatchObject({ scheduled: 1, failed: 0 })
    expect(sendsTo(context.email)).toBe(0)
    const reminder = await prisma.invoiceReminder.findFirstOrThrow({ where: { invoiceId: invoice.id } })
    expect(await prisma.job.findUniqueOrThrow({ where: { dedupeKey: `reminder:${reminder.id}` } })).toMatchObject({
      status: "pending",
    })

    await runOrganizationJobs([context.org.organizationId])
    expect(sendsTo(context.email)).toBe(1)
  })

  it("skips a queued reminder once a later reminder is due or sent", async () => {
    const context = await setup({ policy: { enabled: true, offsetsDays: [7, 14] } })
    const invoice = await createInvoice(context, { issuedDaysAgo: 40, dueInDays: -20, status: "overdue" })
    const [older, newer] = await Promise.all([
      prisma.invoiceReminder.create({
        data: { invoiceId: invoice.id, offsetDays: 7, scheduledFor: daysFromNow(-13) },
      }),
      prisma.invoiceReminder.create({
        data: { invoiceId: invoice.id, offsetDays: 14, scheduledFor: daysFromNow(-6) },
      }),
    ])

    await handleReminderSendJob({ organizationId: context.org.organizationId, payload: { reminderId: older.id } })
    await handleReminderSendJob({ organizationId: context.org.organizationId, payload: { reminderId: newer.id } })

    expect(sendsTo(context.email)).toBe(1)
    expect(await prisma.invoiceReminder.findUniqueOrThrow({ where: { id: older.id } })).toMatchObject({
      outcome: "skipped",
      outcomeMessage: SUPERSEDED_MESSAGE,
    })
    expect(await prisma.invoiceReminder.findUniqueOrThrow({ where: { id: newer.id } })).toMatchObject({
      outcome: "sent",
    })
  })

  it("skips queued reminders when the policy is turned off or the offset removed", async () => {
    const context = await setup({ policy: { enabled: true, offsetsDays: [7, 14] } })
    const first = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10, status: "overdue" })
    const second = await createInvoice(context, { issuedDaysAgo: 30, dueInDays: -10, status: "overdue" })
    const [disabledReminder, removedReminder] = await Promise.all(
      [first, second].map((invoice) =>
        prisma.invoiceReminder.create({
          data: { invoiceId: invoice.id, offsetDays: 7, scheduledFor: daysFromNow(-3) },
        })
      )
    )
    const actor = context.org.actors.admin
    const deliver = (reminderId: string) =>
      handleReminderSendJob({ organizationId: context.org.organizationId, payload: { reminderId } })

    await executeCommand(updateReminderPolicy, { enabled: true, offsetsDays: [14] }, { actor })
    await deliver(removedReminder!.id)
    await executeCommand(updateReminderPolicy, { enabled: false, offsetsDays: [7, 14] }, { actor })
    await deliver(disabledReminder!.id)

    expect(sendsTo(context.email)).toBe(0)
    expect(await prisma.invoiceReminder.findUniqueOrThrow({ where: { id: removedReminder!.id } })).toMatchObject({
      outcome: "skipped",
      outcomeMessage: OFFSET_REMOVED_MESSAGE,
    })
    expect(await prisma.invoiceReminder.findUniqueOrThrow({ where: { id: disabledReminder!.id } })).toMatchObject({
      outcome: "skipped",
      outcomeMessage: POLICY_DISABLED_MESSAGE,
    })
  })

  async function createManyInvoices(
    context: { org: { organizationId: string }; contactId: string },
    count: number,
    input: { dueInDays: number; amountPaid?: number }
  ) {
    const ids = Array.from({ length: count }, () => randomUUID())
    await prisma.invoice.createMany({
      data: ids.map((id) => ({
        id,
        organizationId: context.org.organizationId,
        contactId: context.contactId,
        number: `INV-${id.slice(0, 8)}`,
        status: "sent",
        issueDate: daysFromNow(-60),
        dueDate: daysFromNow(input.dueInDays),
        subtotalNet: 100,
        totalGross: 100,
        amountPaid: input.amountPaid ?? 0,
      })),
    })
    return ids
  }

  it("marks overdue in bounded batches and is not held up by settled invoices", async () => {
    const context = await setup()
    const organizationIds = [context.org.organizationId]
    // Settled but still "sent": never overdue, and must not fill the batch tick after tick.
    await createManyInvoices(context, OVERDUE_BATCH_SIZE, { dueInDays: -30, amountPaid: 100 })
    await createManyInvoices(context, OVERDUE_BATCH_SIZE + 5, { dueInDays: -10 })

    const first = await runOverdueTask(new Date(), { organizationIds })
    expect(first).toMatchObject({ marked: OVERDUE_BATCH_SIZE, failed: 0, remaining: 1 })
    const second = await runOverdueTask(new Date(), { organizationIds })
    expect(second).toMatchObject({ marked: 5, failed: 0, remaining: 0 })
    expect(
      await prisma.invoice.count({ where: { organizationId: context.org.organizationId, status: "overdue" } })
    ).toBe(OVERDUE_BATCH_SIZE + 5)
  })

  it("schedules reminders in bounded batches and is not held up by reminded invoices", async () => {
    const context = await setup({ policy: { enabled: true, offsetsDays: [7] } })
    const organizationIds = [context.org.organizationId]
    const reminded = await createManyInvoices(context, REMINDER_BATCH_SIZE, { dueInDays: -30 })
    await prisma.invoiceReminder.createMany({
      data: reminded.map((invoiceId) => ({
        invoiceId,
        offsetDays: 7,
        scheduledFor: daysFromNow(-23),
        sentAt: daysFromNow(-23),
        outcome: "sent",
      })),
    })
    await createManyInvoices(context, REMINDER_BATCH_SIZE + 3, { dueInDays: -10 })

    const first = await runReminderTask(new Date(), { organizationIds })
    expect(first).toMatchObject({ scheduled: REMINDER_BATCH_SIZE, failed: 0, remaining: 1 })
    const second = await runReminderTask(new Date(), { organizationIds })
    expect(second).toMatchObject({ scheduled: 3, failed: 0, remaining: 0 })
    const third = await runReminderTask(new Date(), { organizationIds })
    expect(third).toMatchObject({ scheduled: 0, remaining: 0 })
  })
})
