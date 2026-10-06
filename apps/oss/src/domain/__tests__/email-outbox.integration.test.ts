import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../lib/email", async () => {
  const actual = await vi.importActual<typeof import("../../lib/email")>("../../lib/email")
  return { ...actual, deliver: vi.fn().mockResolvedValue({ id: "email_123" }) }
})

import { prisma } from "../../lib/db"
import { deliver, EmailSendError } from "../../lib/email"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { authenticateAgentSecret, createAgentKey } from "../agent-keys"
import { decideApproval } from "../approvals"
import { createContact } from "../commands/contacts"
import { createInvoiceDraft, sendInvoice, updateInvoiceDraft } from "../commands/invoices"
import { EMAIL_DELIVERY_ATTEMPTS, EMAIL_DELIVERY_JOB, isDefiniteRejection } from "../delivery/outbox"
import { readActivity } from "../events"
import { executeCommand } from "../execute"
import { runDueJobs } from "../jobs"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

describe("isDefiniteRejection", () => {
  it("treats provider validation errors as refusals and outages or lost requests as uncertain", () => {
    expect(isDefiniteRejection(new EmailSendError("validation_error", "bad"))).toBe(true)
    expect(isDefiniteRejection(new EmailSendError("invalid_from_address", "bad"))).toBe(true)
    // The Resend SDK reports network failures as application_error.
    expect(isDefiniteRejection(new EmailSendError("application_error", "fetch failed"))).toBe(false)
    expect(isDefiniteRejection(new EmailSendError("internal_server_error", "oops"))).toBe(false)
    expect(isDefiniteRejection(new EmailSendError("rate_limit_exceeded", "slow down"))).toBe(false)
    expect(isDefiniteRejection(new Error("socket hang up"))).toBe(false)
  })
})

describeIfDatabase("email outbox", () => {
  const cleanups: Array<() => Promise<void>> = []
  const previousEnv = { RESEND_API_KEY: process.env.RESEND_API_KEY, FROM_EMAIL: process.env.FROM_EMAIL }

  beforeEach(() => {
    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@example.com"
    vi.mocked(deliver).mockReset()
    vi.mocked(deliver).mockResolvedValue({ id: "email_123" })
  })

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
    process.env.RESEND_API_KEY = previousEnv.RESEND_API_KEY
    process.env.FROM_EMAIL = previousEnv.FROM_EMAIL
  })

  async function setup() {
    const org = await createTestOrganization({ roles: ["admin"] })
    cleanups.push(org.cleanup)
    const contact = await executeCommand(
      createContact,
      { name: "Acme", email: "billing@acme.test" },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    const draft = await executeCommand(
      createInvoiceDraft,
      {
        contactId: contact.result.id,
        dueDate: "2099-12-01",
        taxRate: 0,
        items: [{ description: "Design", quantity: 1, unitPrice: 100 }],
      },
      { actor: org.actors.admin }
    )
    if (draft.status !== "completed") throw new Error("draft setup failed")
    return { org, contactId: contact.result.id, invoiceId: draft.result.id }
  }

  const deliveryJob = (organizationId: string) =>
    prisma.job.findFirstOrThrow({ where: { organizationId, type: EMAIL_DELIVERY_JOB } })

  /** Makes the queued delivery due again, as if its backoff had passed. */
  const makeDue = (jobId: string) =>
    prisma.job.update({ where: { id: jobId }, data: { runAfter: new Date(Date.now() - 1000) } })

  it("marks the invoice sent only after the provider accepts the email", async () => {
    const { org, invoiceId } = await setup()
    let statusDuringDelivery: string | undefined
    vi.mocked(deliver).mockImplementationOnce(async () => {
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
      statusDuringDelivery = `${invoice.status}/${invoice.lastEmailAttemptOutcome}`
      return { id: "email_1" }
    })

    const outcome = await executeCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })

    expect(outcome).toMatchObject({ status: "completed", result: { emailPending: true } })
    expect(statusDuringDelivery).toBe("draft/sending")
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(invoice).toMatchObject({ status: "sent", lastEmailAttemptOutcome: "sent" })
    expect(invoice.issueDate.getTime()).toBe(invoice.lastEmailAttemptAt?.getTime())
    const activity = await readActivity({ organizationId: org.organizationId, aggregateId: invoiceId })
    expect(activity.events.at(-1)).toMatchObject({
      type: "invoice.sent",
      actor: { kind: "user", id: org.actors.admin.userId },
    })
  })

  it("leaves an editable draft when the provider refuses the email", async () => {
    const { org, invoiceId } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("validation_error", "Domain is not verified"))

    await executeCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(invoice).toMatchObject({
      status: "draft",
      lastEmailAttemptOutcome: "failed",
      lastEmailAttemptCode: "send_failed",
    })
    expect(invoice.lastEmailAttemptMessage).toContain("Domain is not verified")
    expect((await deliveryJob(org.organizationId)).status).toBe("done")
    const edited = await executeCommand(
      updateInvoiceDraft,
      { id: invoiceId, notes: "Fixed the sender" },
      { actor: org.actors.admin }
    )
    expect(edited.status).toBe("completed")
  })

  it("replays the identical stored message and key after an uncertain failure", async () => {
    const { org, invoiceId, contactId } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("application_error", "fetch failed"))

    await executeCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })

    const frozen = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(frozen).toMatchObject({ status: "draft", lastEmailAttemptOutcome: "sending" })
    const blocked = await executeCommand(
      updateInvoiceDraft,
      { id: invoiceId, notes: "Changed while sending" },
      { actor: org.actors.admin }
    )
    expect(blocked).toMatchObject({ status: "failed", error: { code: "send_in_progress" } })

    // Changing the contact before the retry must not change what is delivered.
    await prisma.contact.update({ where: { id: contactId }, data: { email: "someone-else@acme.test" } })
    const job = await deliveryJob(org.organizationId)
    expect(job.status).toBe("pending")
    await makeDue(job.id)
    await runDueJobs({ organizationIds: [org.organizationId] })

    expect(deliver).toHaveBeenCalledTimes(2)
    const [first, second] = vi.mocked(deliver).mock.calls
    expect(second).toEqual(first)
    expect(first?.[0]).toMatchObject({ to: "billing@acme.test" })
    expect(first?.[1]?.idempotencyKey).toMatch(new RegExp(`^invoice-send:${invoiceId}:\\d+$`))
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(invoice).toMatchObject({ status: "sent", lastEmailAttemptOutcome: "sent" })
    expect(invoice.issueDate.getTime()).toBe(frozen.lastEmailAttemptAt?.getTime())
  })

  it("gives up an unconfirmed delivery after its last attempt and unfreezes the draft", async () => {
    const { org, invoiceId } = await setup()
    vi.mocked(deliver).mockRejectedValue(new Error("socket hang up"))

    await executeCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    const job = await deliveryJob(org.organizationId)
    await prisma.job.update({ where: { id: job.id }, data: { attempts: EMAIL_DELIVERY_ATTEMPTS - 1 } })
    await makeDue(job.id)
    await runDueJobs({ organizationIds: [org.organizationId] })

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(invoice).toMatchObject({
      status: "draft",
      lastEmailAttemptOutcome: "failed",
      lastEmailAttemptCode: "delivery_unconfirmed",
    })
    expect((await deliveryJob(org.organizationId)).status).toBe("done")
  })

  it("never lets a delivery settle a document that is no longer waiting for it", async () => {
    const { org, invoiceId } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new Error("socket hang up"))
    await executeCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })

    // Another attempt owns the marker now (e.g. an operator cleared and re-sent it).
    const newer = new Date(Date.now() + 60_000)
    await prisma.invoice.update({ where: { id: invoiceId }, data: { lastEmailAttemptAt: newer } })
    const job = await deliveryJob(org.organizationId)
    await makeDue(job.id)
    await runDueJobs({ organizationIds: [org.organizationId] })

    expect(deliver).toHaveBeenCalledTimes(1)
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(invoice).toMatchObject({ status: "draft", lastEmailAttemptOutcome: "sending" })
    expect(invoice.lastEmailAttemptAt?.getTime()).toBe(newer.getTime())
  })

  describe("approved agent sends", () => {
    async function queued() {
      const ctx = await setup()
      const { secret } = await createAgentKey(ctx.org.actors.admin, {
        name: "Bookkeeper",
        mode: "approval_required",
        scopes: ["invoice:send", "invoice:update", "invoice:read"],
      })
      const agent = await authenticateAgentSecret(secret)
      const request = await executeCommand(sendInvoice, { id: ctx.invoiceId }, { actor: agent, clientRequestId: "s1" })
      if (request.status !== "awaiting_approval") throw new Error("expected approval")
      return { ...ctx, agent, request }
    }

    it("records the delivery as the agent, approved by the reviewer", async () => {
      const { org, invoiceId, request, agent } = await queued()

      const decided = await decideApproval({
        approvalRequestId: request.approvalRequestId,
        decider: org.actors.admin,
        decision: "approve",
      })

      expect(decided.status).toBe("completed")
      const sent = await prisma.domainEvent.findFirstOrThrow({
        where: { organizationId: org.organizationId, aggregateId: invoiceId, type: "invoice.sent" },
      })
      expect(sent).toMatchObject({
        actorKind: "agent",
        actorId: agent.agentKeyId,
        approvedByUserId: org.actors.admin.userId,
        commandId: request.commandId,
      })
    })

    it("leaves the draft untouched when the document changed since review", async () => {
      const { org, invoiceId, request, agent } = await queued()
      await executeCommand(updateInvoiceDraft, { id: invoiceId, notes: "Edited after queuing" }, { actor: agent })

      const decided = await decideApproval({
        approvalRequestId: request.approvalRequestId,
        decider: org.actors.admin,
        decision: "approve",
      })

      expect(decided).toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
      expect(deliver).not.toHaveBeenCalled()
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
      expect(invoice).toMatchObject({ status: "draft", lastEmailAttemptOutcome: null })
      const receipt = await prisma.commandReceipt.findUniqueOrThrow({ where: { id: request.commandId } })
      expect(receipt.status).toBe("failed")
    })
  })
})
