import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { appRouter } from "../../trpc/router"
import { runDueJobs } from "../jobs"
import { PAYMENT_DETAILS_CHANGED_JOB, PAYMENT_DETAILS_NOTIFICATION_DELAY_MS } from "../payment-details-notification"
import { eventDefinition } from "../events/registry"

const logged = vi.hoisted(() => [] as Array<{ level: string; event: string; data: unknown }>)
vi.mock("../../lib/observability", () => {
  const logger = (): Record<string, unknown> => ({
    debug: (event: string, data?: unknown) => logged.push({ level: "debug", event, data }),
    info: (event: string, data?: unknown) => logged.push({ level: "info", event, data }),
    warn: (event: string, data?: unknown) => logged.push({ level: "warn", event, data }),
    error: (event: string, data?: unknown) => logged.push({ level: "error", event, data }),
    child: () => logger(),
  })
  return { appLogger: logger() }
})

const send = vi.hoisted(() => vi.fn())
vi.mock("resend", () => ({ Resend: class { emails = { send } } }))

const account = {
  accountHolder: "Nordic Design ApS",
  bankName: "Danske Bank",
  regNumber: "0040",
  accountNumber: "0440116243",
  iban: "DK5000400440116243",
  bic: "DABADKKK",
}
const otherIban = "DE89370400440532013000"

const cleanups: Array<() => Promise<void>> = []
beforeEach(() => {
  logged.length = 0
  send.mockReset()
  send.mockResolvedValue({ data: { id: "message-1" }, error: null })
  vi.stubEnv("RESEND_API_KEY", "test-only-key")
  vi.stubEnv("FROM_EMAIL", "noreply@quits.test")
})
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  vi.unstubAllEnvs()
})

function callerFor(organizationId: string, userId: string) {
  return appRouter.createCaller({
    session: {
      user: { id: userId, email: `${userId}@test.quits.invalid`, name: `${userId} user` },
      session: { activeOrganizationId: organizationId },
    },
  } as never)
}

async function setup(settings: { locale?: string; timezone?: string } = {}) {
  const org = await createTestOrganization({ roles: ["admin", "member", "accountant"], settings })
  cleanups.push(org.cleanup)
  return { org, admin: callerFor(org.organizationId, org.actors.admin.userId) }
}

const events = (organizationId: string) =>
  prisma.domainEvent.findMany({
    where: { organizationId, type: "organization.payment_details_updated" },
    orderBy: { sequence: "asc" },
  })
const jobs = (organizationId: string) =>
  prisma.job.findMany({ where: { organizationId, type: PAYMENT_DETAILS_CHANGED_JOB }, orderBy: { createdAt: "asc" } })

/** Runs what the scheduler tick would once the notification delay has passed. */
const tick = (organizationId: string) =>
  runDueJobs({
    organizationIds: [organizationId],
    now: new Date(Date.now() + PAYMENT_DETAILS_NOTIFICATION_DELAY_MS + 60_000),
  })

;(hasTestDatabase ? describe : describe.skip)("payment details audit trail", () => {
  it("records a change with masked before and after values and the actor", async () => {
    const { org, admin } = await setup()
    await admin.paymentDetails.update({ bankAccount: account, note: "MobilePay Box 12345" })
    await admin.paymentDetails.update({ bankAccount: { ...account, iban: otherIban, bic: "COBADEFF" }, note: "MobilePay Box 12345" })

    const recorded = await events(org.organizationId)
    expect(recorded).toHaveLength(2)

    const [first, second] = recorded
    // The person is named by the email and id of their account, not only by the name they chose.
    const changedBy = {
      kind: "user",
      id: org.actors.admin.userId,
      name: expect.any(String),
      email: `${org.actors.admin.userId}@test.quits.invalid`,
    }
    expect(first!.payload).toEqual({
      changedBy,
      changes: [
        { field: "accountHolder", before: null, after: "Nordic Design ApS" },
        { field: "bankName", before: null, after: "Danske Bank" },
        { field: "regNumber", before: null, after: "0040" },
        { field: "accountNumber", before: null, after: "****6243" },
        { field: "iban", before: null, after: "DK****6243" },
        { field: "bic", before: null, after: "DABADKKK" },
        { field: "note", before: null, after: "****" },
      ],
    })
    expect(second!.payload).toEqual({
      changedBy,
      changes: [
        { field: "iban", before: "DK****6243", after: "DE****3000" },
        { field: "bic", before: "DABADKKK", after: "COBADEFF" },
      ],
    })
    expect(second).toMatchObject({
      aggregateType: "organization",
      aggregateId: org.organizationId,
      schemaVersion: eventDefinition("organization.payment_details_updated")!.version,
      actorKind: "user",
      actorId: org.actors.admin.userId,
      actorLabel: `${org.actors.admin.userId} user`,
    })
  })

  it("names the person by their account, not by the display name the session carries", async () => {
    const { org } = await setup()
    // A display name is the user's own choice: here one that poses as someone else.
    const caller = appRouter.createCaller({
      session: {
        user: { id: org.actors.admin.userId, email: "ignored@example.test", name: "Anna the CEO" },
        session: { activeOrganizationId: org.organizationId },
      },
    } as never)
    await caller.paymentDetails.update({ bankAccount: account })

    const user = await prisma.user.findUniqueOrThrow({ where: { id: org.actors.admin.userId } })
    const [event] = await events(org.organizationId)
    expect((event!.payload as { changedBy: unknown }).changedBy).toEqual({
      kind: "user",
      id: user.id,
      name: user.name,
      email: user.email,
    })
    const [job] = await jobs(org.organizationId)
    expect((job!.payload as { changedBy: unknown }).changedBy).toEqual({ kind: "user", id: user.id, name: user.name, email: user.email })

    await tick(org.organizationId)
    const [message] = send.mock.calls[0]!
    expect(message.html).toContain(`&lt;${user.email}&gt;`)
    expect(message.html).not.toContain("ignored@example.test")
  })

  it("chains the before and after values of saves made at once", async () => {
    const { org, admin } = await setup()
    await admin.paymentDetails.update({ bankAccount: account })
    const other = { ...account, accountNumber: "0440116300", iban: "DK6300400440116300" }
    const third = { ...account, accountNumber: "0440116400", iban: "DK7900400440116400" }
    await Promise.all([admin.paymentDetails.update({ bankAccount: other }), admin.paymentDetails.update({ bankAccount: third })])

    const accountEvents = (await events(org.organizationId)).map(
      (event) => (event.payload as { changes: Array<{ field: string; before: string | null; after: string | null }> }).changes.find((change) => change.field === "iban")!
    )
    expect(accountEvents).toHaveLength(3)
    // Each save starts from what the previous one left, whichever of the two ran first.
    expect(accountEvents[1]!.before).toBe(accountEvents[0]!.after)
    expect(accountEvents[2]!.before).toBe(accountEvents[1]!.after)
  })

  it("never stores a full IBAN, account number or note in an event or a job", async () => {
    const { org, admin } = await setup()
    await admin.paymentDetails.update({ bankAccount: account, note: "Pay to account 0440116243" })
    await admin.paymentDetails.update({ bankAccount: { ...account, iban: otherIban } })

    const stored = JSON.stringify([
      (await events(org.organizationId)).map((event) => event.payload),
      (await jobs(org.organizationId)).map((job) => job.payload),
    ])
    for (const secret of [account.iban, otherIban, account.accountNumber, "Pay to account"]) {
      expect(stored).not.toContain(secret)
    }
    // The settings themselves of course hold the numbers; only the trail is masked.
    expect((await admin.paymentDetails.get()).bankAccount?.iban).toBe(otherIban)
  })

  it("records nothing when the same details are saved again", async () => {
    const { org, admin } = await setup()
    await admin.paymentDetails.update({ bankAccount: account, note: null })
    await admin.paymentDetails.update({ bankAccount: { ...account, iban: "dk50 0040 0440 1162 43" }, note: "  " })
    await admin.paymentDetails.update({ bankAccount: {}, note: null }).catch(() => undefined)

    // The third call clears the account (a change); the second changed nothing.
    expect(await events(org.organizationId)).toHaveLength(2)
    expect(await jobs(org.organizationId)).toHaveLength(2)
  })

  it("records nothing for a rejected update", async () => {
    const { org, admin } = await setup()
    await expect(admin.paymentDetails.update({ bankAccount: { iban: "DK50004004401162430" } })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    expect(await events(org.organizationId)).toHaveLength(0)
    expect(await jobs(org.organizationId)).toHaveLength(0)
  })

  it("records nothing when a member without the right tries to change the details", async () => {
    const { org } = await setup()
    const member = callerFor(org.organizationId, org.actors.member.userId)
    await expect(member.paymentDetails.update({ bankAccount: account })).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(await events(org.organizationId)).toHaveLength(0)
  })

  it("shows the change on the activity page's audit log", async () => {
    const { org, admin } = await setup()
    await admin.paymentDetails.update({ bankAccount: account })
    const page = await admin.activity.list({ aggregateType: "organization", order: "desc" })
    expect(page.events[0]).toMatchObject({
      type: "organization.payment_details_updated",
      aggregateType: "organization",
      aggregateId: org.organizationId,
    })
  })
})

;(hasTestDatabase ? describe : describe.skip)("payment details change notification", () => {
  it("does not make saving wait for the email", async () => {
    const { org, admin } = await setup()
    await admin.paymentDetails.update({ bankAccount: account })

    // Queued for the scheduler, not run while the person who saved is waiting.
    const [job] = await jobs(org.organizationId)
    expect(job).toMatchObject({ status: "pending" })
    expect(job!.runAfter.getTime()).toBeGreaterThan(Date.now() + PAYMENT_DETAILS_NOTIFICATION_DELAY_MS - 5_000)
    expect(send).not.toHaveBeenCalled()
  })

  it("emails the admins in the organization's language, with masked values and what to do", async () => {
    const { org, admin } = await setup({ locale: "da-DK", timezone: "Europe/Copenhagen" })
    await admin.paymentDetails.update({ bankAccount: account })
    await admin.paymentDetails.update({ bankAccount: { ...account, iban: otherIban } })

    expect(await tick(org.organizationId)).toMatchObject({ succeeded: 2, failed: 0 })

    // One email per change and admin; the member and the accountant are not told.
    expect(send).toHaveBeenCalledTimes(2)
    const recipients = send.mock.calls.map(([message]) => message.to)
    expect(new Set(recipients)).toEqual(new Set([`${org.actors.admin.userId}@test.quits.invalid`]))

    const [message, options] = send.mock.calls[1]!
    expect(message).toMatchObject({
      from: "Quits <noreply@quits.test>",
      subject: "Bankoplysningerne på dine fakturaer er ændret",
    })
    expect(message.html).toContain(`ændret af ${org.actors.admin.userId} &lt;${org.actors.admin.userId}@test.quits.invalid&gt;.`)
    expect(message.html).toContain("DK****6243")
    expect(message.html).toContain("DE****3000")
    expect(message.html).toContain("Hvis det ikke var dig, skal du skifte din adgangskode og tjekke dine indstillinger.")
    for (const secret of [account.iban, otherIban, account.accountNumber]) {
      expect(message.html).not.toContain(secret)
    }
    expect(options).toEqual({ idempotencyKey: expect.stringContaining("payment-details-changed:") })
  })

  it("also tells a second admin, and counts nobody twice", async () => {
    const { org, admin } = await setup()
    const second = await prisma.user.create({
      data: {
        id: `second-${org.organizationId}`,
        email: "second.admin@test.quits.invalid",
        name: "Second Admin",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })
    await prisma.member.create({
      data: { id: `${org.organizationId}:second`, organizationId: org.organizationId, userId: second.id, role: "admin,member", createdAt: new Date() },
    })
    cleanups.push(async () => {
      await prisma.member.deleteMany({ where: { userId: second.id } })
      await prisma.user.delete({ where: { id: second.id } })
    })

    await admin.paymentDetails.update({ bankAccount: account })
    await tick(org.organizationId)

    expect(send.mock.calls.map(([message]) => message.to).sort()).toEqual(
      [`${org.actors.admin.userId}@test.quits.invalid`, "second.admin@test.quits.invalid"].sort()
    )
  })

  it("skips the email quietly, logging at info level, when no email provider is configured", async () => {
    vi.stubEnv("RESEND_API_KEY", "")
    const { org, admin } = await setup()

    await expect(admin.paymentDetails.update({ bankAccount: account })).resolves.toMatchObject({ canUpdate: true })
    expect(await tick(org.organizationId)).toMatchObject({ succeeded: 1, failed: 0, retrying: 0 })

    expect(send).not.toHaveBeenCalled()
    expect(logged).toContainEqual({
      level: "info",
      event: "payment_details.notification_skipped",
      data: expect.objectContaining({ organizationId: org.organizationId, reason: "email_delivery_not_configured" }),
    })
    expect(logged.filter((entry) => ["warn", "error"].includes(entry.level) && entry.event.startsWith("payment_details"))).toEqual([])
    // The change is still in the audit log.
    expect(await events(org.organizationId)).toHaveLength(1)
    expect((await jobs(org.organizationId))[0]).toMatchObject({ status: "done" })
  })

  it("skips the email without a sender address too", async () => {
    vi.stubEnv("FROM_EMAIL", "")
    const { org, admin } = await setup()
    await admin.paymentDetails.update({ bankAccount: account })
    await tick(org.organizationId)
    expect(send).not.toHaveBeenCalled()
    expect(logged).toContainEqual(expect.objectContaining({ level: "info", event: "payment_details.notification_skipped" }))
  })

  it("never fails the update or the job when the provider rejects an email", async () => {
    send.mockRejectedValue(new Error("provider down"))
    const { org, admin } = await setup()

    await expect(admin.paymentDetails.update({ bankAccount: account })).resolves.toMatchObject({ bankAccount: account })
    expect(await tick(org.organizationId)).toMatchObject({ succeeded: 1, failed: 0, retrying: 0 })

    expect(send).toHaveBeenCalledTimes(1)
    expect(logged).toContainEqual(expect.objectContaining({ level: "warn", event: "payment_details.notification_failed" }))
    expect((await admin.paymentDetails.get()).bankAccount).toEqual(account)
    expect(await events(org.organizationId)).toHaveLength(1)
  })
})
