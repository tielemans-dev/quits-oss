import { afterEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { authenticateAgentSecret, createAgentKey, revokeAgentKey } from "../agent-keys"
import { decideApproval, expireStaleApprovals } from "../approvals"
import { createContact } from "../commands/contacts"
import { createInvoiceDraft, sendInvoice, updateInvoiceDraft } from "../commands/invoices"
import { recordPayment } from "../commands/payments"
import { executeCommand } from "../execute"
import { markOrganizationInvoicesOverdue } from "../features/overdue"
import { readActivity } from "../events"
import { reclaimStaleJobs, registerJobHandler } from "../jobs"
import { runOrganizationJobs } from "../scheduler"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

/** Regression tests for findings from the cross-model (Codex) review of the lifecycle branch. */
describeIfDatabase("review fixes", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function setup(options: { send?: boolean; dueDate?: string; roles?: Array<"admin" | "member" | "accountant"> } = {}) {
    const org = await createTestOrganization({ roles: options.roles ?? ["admin"] })
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
        dueDate: options.dueDate ?? "2099-12-01",
        taxRate: 0,
        items: [{ description: "Design", quantity: 1, unitPrice: 100 }],
      },
      { actor: org.actors.admin }
    )
    if (draft.status !== "completed") throw new Error("draft setup failed")
    if (options.send) {
      const sent = await executeCommand(
        sendInvoice,
        { id: draft.result.id, allowSendWithoutEmail: true },
        { actor: org.actors.admin }
      )
      if (sent.status !== "completed") throw new Error("send setup failed")
    }
    return { org, invoiceId: draft.result.id }
  }

  it("gives concurrent calls with the same client request id the same outcome", async () => {
    const { org, invoiceId } = await setup({ send: true })
    const input = { invoiceId, amount: 100, paidAt: "2026-01-15", method: "bank_transfer" }
    const options = { actor: org.actors.admin, clientRequestId: "pay-once" }

    const [first, second] = await Promise.all([
      executeCommand(recordPayment, input, options),
      executeCommand(recordPayment, input, options),
    ])

    expect(first.status).toBe("completed")
    expect(second).toEqual(first)
    expect(await prisma.payment.count({ where: { invoiceId } })).toBe(1)
  })

  it("derives a stable command id from the client request id", async () => {
    const { org } = await setup()
    const a = await executeCommand(createContact, { name: "B" }, { actor: org.actors.admin, clientRequestId: "same" })
    const b = await executeCommand(createContact, { name: "B" }, { actor: org.actors.admin, clientRequestId: "same" })
    expect(a.commandId).toMatch(/^cmd_[0-9a-f]{32}$/)
    expect(b.commandId).toBe(a.commandId)
  })

  it("marks overdue through the command, skipping settled invoices and auditing the change", async () => {
    const { org, invoiceId } = await setup({ send: true, dueDate: "2020-01-01" })
    const paid = await setup({ send: true, dueDate: "2020-01-01" })
    await executeCommand(
      recordPayment,
      { invoiceId: paid.invoiceId, amount: 100, paidAt: "2026-01-15", method: "bank_transfer" },
      { actor: paid.org.actors.admin }
    )

    const outcome = await executeCommand(markOrganizationInvoicesOverdue, {}, { actor: org.actors.admin })
    expect(outcome).toMatchObject({ status: "completed", result: { marked: 1 } })
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("overdue")

    const activity = await readActivity({ organizationId: org.organizationId, aggregateId: invoiceId })
    expect(activity.events.at(-1)).toMatchObject({ type: "invoice.became_overdue", actor: { kind: "user" } })

    const settled = await executeCommand(markOrganizationInvoicesOverdue, {}, { actor: paid.org.actors.admin })
    expect(settled).toMatchObject({ status: "completed", result: { marked: 0 } })
  })

  describe("approvals", () => {
    async function queuedSend() {
      const ctx = await setup()
      const { secret } = await createAgentKey(ctx.org.actors.admin, {
        name: "Bookkeeper",
        mode: "approval_required",
        scopes: ["invoice:send", "invoice:read"],
      })
      const agent = await authenticateAgentSecret(secret)
      const queued = await executeCommand(
        sendInvoice,
        { id: ctx.invoiceId, allowSendWithoutEmail: true },
        { actor: agent, clientRequestId: "send-1" }
      )
      if (queued.status !== "awaiting_approval") throw new Error("expected approval")
      return { ...ctx, agent, queued }
    }

    it("finalizes receipts when the agent key is revoked", async () => {
      const { org, agent, queued } = await queuedSend()
      await revokeAgentKey(org.actors.admin, agent.agentKeyId)

      const receipt = await prisma.commandReceipt.findUniqueOrThrow({ where: { id: queued.commandId } })
      expect(receipt.status).toBe("expired")
      expect(receipt.error).toMatchObject({ tag: "Revoked" })
    })

    it("does not let expiry overwrite a request that was already approved", async () => {
      const { org, queued } = await queuedSend()
      const approved = await decideApproval({
        approvalRequestId: queued.approvalRequestId,
        decider: org.actors.admin,
        decision: "approve",
      })
      expect(approved.status).toBe("completed")

      await prisma.approvalRequest.update({
        where: { id: queued.approvalRequestId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })
      await expireStaleApprovals(org.organizationId)

      const request = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: queued.approvalRequestId } })
      const receipt = await prisma.commandReceipt.findUniqueOrThrow({ where: { id: queued.commandId } })
      expect(request.status).toBe("approved")
      expect(receipt.status).toBe("completed")
    })

    it("resumes an approval whose command never ran", async () => {
      const { org, invoiceId, queued } = await queuedSend()
      // Simulate a crash between recording the approval and running the command.
      await prisma.approvalRequest.update({
        where: { id: queued.approvalRequestId },
        data: { status: "approved", decidedByUserId: org.actors.admin.userId, decidedAt: new Date() },
      })
      await prisma.commandReceipt.update({
        where: { id: queued.commandId },
        data: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) },
      })

      const resumed = await decideApproval({
        approvalRequestId: queued.approvalRequestId,
        decider: org.actors.admin,
        decision: "approve",
      })
      expect(resumed.status).toBe("completed")
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("sent")
    })

    it("shows reviewers the document and refuses to send it if the agent changes it afterwards", async () => {
      const ctx = await setup()
      const { secret } = await createAgentKey(ctx.org.actors.admin, {
        name: "Drafter",
        mode: "approval_required",
        scopes: ["invoice:send", "invoice:update", "invoice:read"],
      })
      const agent = await authenticateAgentSecret(secret)
      const queued = await executeCommand(
        sendInvoice,
        { id: ctx.invoiceId, allowSendWithoutEmail: true },
        { actor: agent, clientRequestId: "send-reviewed" }
      )
      if (queued.status !== "awaiting_approval") throw new Error("expected approval")

      const request = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: queued.approvalRequestId } })
      expect(request.summary).toBe("Send invoice INV-0001 (100.00 USD) to billing@acme.test")
      expect(request.reviewContext).toMatchObject({
        details: { number: "INV-0001", recipient: "billing@acme.test", total: "100.00" },
      })

      // Drafting is not gated, so the agent can still change the invoice after queuing the send.
      const edited = await executeCommand(
        updateInvoiceDraft,
        { id: ctx.invoiceId, items: [{ description: "Design", quantity: 1, unitPrice: 9999 }] },
        { actor: agent }
      )
      expect(edited.status).toBe("completed")

      const decided = await decideApproval({
        approvalRequestId: queued.approvalRequestId,
        decider: ctx.org.actors.admin,
        decision: "approve",
      })
      expect(decided).toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: ctx.invoiceId } })).status).toBe("draft")
    })

    it("requires the command's permission to reject as well as approve", async () => {
      const { org, queued } = await queuedSend()
      const accountant = await createTestOrganization({ roles: ["accountant"] })
      cleanups.push(accountant.cleanup)
      const outsiderRole = { ...accountant.actors.accountant, organizationId: org.organizationId }

      await expect(
        decideApproval({ approvalRequestId: queued.approvalRequestId, decider: outsiderRole, decision: "reject" })
      ).rejects.toMatchObject({ _tag: "Forbidden" })
    })
  })

  it("reclaims jobs abandoned by a runner that stopped", async () => {
    const { org } = await setup()
    const handler = vi.fn(async () => undefined)
    registerJobHandler("test.reclaim", handler)
    const job = await prisma.job.create({
      data: {
        organizationId: org.organizationId,
        type: "test.reclaim",
        payload: {},
        status: "running",
        attempts: 1,
      },
    })
    await prisma.$executeRaw`UPDATE "job" SET "updatedAt" = NOW() - INTERVAL '30 minutes' WHERE "id" = ${job.id}`

    const reclaimed = await reclaimStaleJobs(new Date(), { organizationIds: [org.organizationId] })
    expect(reclaimed).toEqual({ requeued: 1, failed: 0 })
    await runOrganizationJobs([org.organizationId])

    expect(handler).toHaveBeenCalledTimes(1)
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("done")
  })
})
