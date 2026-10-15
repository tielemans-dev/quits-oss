import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../../lib/db"
import { automaticReminderSuppressed } from "../../../lib/reminders/unsubscribe"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

describeIfDatabase("customer reminder preferences", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })

  async function setup() {
    const org = await createTestOrganization({ roles: ["admin", "accountant"] })
    cleanups.push(org.cleanup)
    const caller = (role: "admin" | "accountant") => appRouter.createCaller({ session: {
      user: { id: org.actors[role].userId, email: `${role}@example.test`, name: role },
      session: { activeOrganizationId: org.organizationId },
    } } as never)
    const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Buyer", email: " BUYER@example.test " } })
    const preference = await prisma.recipientReminderPreference.create({ data: { organizationId: org.organizationId, recipient: "buyer@example.test", locale: "da-DK", unsubscribedAt: new Date() } })
    return { org, contact, preference, admin: caller("admin"), reader: caller("accountant") }
  }

  it("shows the mailbox opt-out, resumes it with an audit event and leaves other organizations opted out", async () => {
    const a = await setup()
    const b = await setup()
    expect(await a.admin.contacts.get({ id: a.contact.id })).toMatchObject({ reminderUnsubscribedAt: a.preference.unsubscribedAt, canResumeReminders: true })
    await a.admin.contacts.resumeReminders({ id: a.contact.id })
    expect(await a.admin.contacts.get({ id: a.contact.id })).toMatchObject({ reminderUnsubscribedAt: null })
    expect(await automaticReminderSuppressed(prisma, a.org.organizationId, "buyer@example.test", false)).toBe(false)
    expect(await automaticReminderSuppressed(prisma, b.org.organizationId, "buyer@example.test", false)).toBe(true)
    const event = await prisma.domainEvent.findFirstOrThrow({ where: { organizationId: a.org.organizationId, aggregateId: a.contact.id, type: "contact.updated" } })
    expect(event.payload).toEqual({ fields: ["reminderUnsubscribedAt"] })
    await a.admin.contacts.resumeReminders({ id: a.contact.id })
    expect(await a.admin.contacts.get({ id: a.contact.id })).toMatchObject({ reminderUnsubscribedAt: null })
  })

  it("requires contact:update and scopes both read and write to the active organization", async () => {
    const a = await setup()
    const b = await setup()
    expect(await a.reader.contacts.get({ id: a.contact.id })).toMatchObject({ reminderUnsubscribedAt: a.preference.unsubscribedAt, canResumeReminders: false })
    await expect(a.reader.contacts.resumeReminders({ id: a.contact.id })).rejects.toThrow()
    await expect(b.admin.contacts.get({ id: a.contact.id })).rejects.toThrow()
    await expect(b.admin.contacts.resumeReminders({ id: a.contact.id })).rejects.toThrow()
    expect(await automaticReminderSuppressed(prisma, a.org.organizationId, "buyer@example.test", false)).toBe(true)
    const noEmail = await prisma.contact.create({ data: { organizationId: a.org.organizationId, name: "No mailbox" } })
    expect(await a.admin.contacts.get({ id: noEmail.id })).toMatchObject({ reminderUnsubscribedAt: null })
    await expect(a.admin.contacts.resumeReminders({ id: noEmail.id })).rejects.toThrow()
  })
})
