import { afterEach, describe, expect, it, vi } from "vitest"
import * as actorPermissions from "../../../domain/actor"
import { authenticateAgentSecret, createAgentKey } from "../../../domain/agent-keys"
import { decideApproval } from "../../../domain/approvals"
import { resumeContactReminders } from "../../../domain/commands/contacts"
import { executeCommand } from "../../../domain/execute"
import { prisma } from "../../../lib/db"
import { automaticReminderSuppressed } from "../../../lib/reminders/unsubscribe"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

describeIfDatabase("customer reminder preferences", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { vi.restoreAllMocks(); while (cleanups.length) await cleanups.pop()?.() })

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
    expect(await prisma.domainEvent.count({ where: { organizationId: a.org.organizationId, aggregateId: a.contact.id, type: "contact.updated" } })).toBe(1)
    const untouched = await prisma.contact.create({ data: { organizationId: a.org.organizationId, name: "Never opted out", email: "other@example.test" } })
    await a.admin.contacts.resumeReminders({ id: untouched.id })
    expect(await prisma.domainEvent.count({ where: { aggregateId: untouched.id } })).toBe(0)
  })

  it("requires invoice:send and scopes both read and write to the active organization", async () => {
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

  it("refuses a contact:update agent without invoice:send", async () => {
    const a = await setup()
    const { secret } = await createAgentKey(a.org.actors.admin, { name: "Contact editor", mode: "approval_required", scopes: ["contact:read", "contact:update"] })
    const actor = await authenticateAgentSecret(secret)
    expect(actorPermissions.actorCan(actor, "contact:update")).toBe(true)
    expect(await executeCommand(resumeContactReminders, { id: a.contact.id }, { actor, clientRequestId: "editor-resume" })).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
    expect(await automaticReminderSuppressed(prisma, a.org.organizationId, "buyer@example.test", false)).toBe(true)
  })

  it("gates the router capability and mutation on invoice:send", async () => {
    const a = await setup()
    const can = actorPermissions.actorCan
    vi.spyOn(actorPermissions, "actorCan").mockImplementation((actor, permission) => permission !== "invoice:send" && can(actor, permission))
    expect(await a.admin.contacts.get({ id: a.contact.id })).toMatchObject({ canResumeReminders: false })
    await expect(a.admin.contacts.resumeReminders({ id: a.contact.id })).rejects.toThrow("invoice:send")
  })

  it("queues recipient-specific approval, rejects a changed mailbox, then resumes only after approval", async () => {
    const a = await setup()
    const { secret } = await createAgentKey(a.org.actors.admin, { name: "Reminder sender", mode: "approval_required", scopes: ["contact:update", "invoice:send"] })
    const actor = await authenticateAgentSecret(secret)
    const queue = (clientRequestId: string) => executeCommand(resumeContactReminders, { id: a.contact.id }, { actor, clientRequestId })
    const queued = await queue("resume-review")
    if (queued.status !== "awaiting_approval") throw new Error(`Expected approval, got ${queued.status}`)
    expect(await automaticReminderSuppressed(prisma, a.org.organizationId, "buyer@example.test", false)).toBe(true)
    const request = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: queued.approvalRequestId } })
    expect(request.summary).toContain("buyer@example.test")
    expect(request.reviewContext).toMatchObject({ details: { recipient: "buyer@example.test", customer: "Buyer" } })
    await prisma.contact.update({ where: { id: a.contact.id }, data: { email: "changed@example.test" } })
    expect(await decideApproval({ approvalRequestId: queued.approvalRequestId, decider: a.org.actors.admin, decision: "approve" })).toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
    await prisma.contact.update({ where: { id: a.contact.id }, data: { email: "buyer@example.test" } })
    const retry = await queue("resume-reviewed-again")
    if (retry.status !== "awaiting_approval") throw new Error(`Expected approval, got ${retry.status}`)
    expect(await decideApproval({ approvalRequestId: retry.approvalRequestId, decider: a.org.actors.admin, decision: "approve" })).toMatchObject({ status: "completed" })
    expect(await automaticReminderSuppressed(prisma, a.org.organizationId, "buyer@example.test", false)).toBe(false)
  })
})
