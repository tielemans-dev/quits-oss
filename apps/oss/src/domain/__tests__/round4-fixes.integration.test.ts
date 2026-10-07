import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { authenticateAgentSecret, createAgentKey } from "../agent-keys"
import { decideApproval, recoverInterruptedApprovals } from "../approvals"
import { appendEvents } from "../events"
import { createContact, updateContact } from "../commands/contacts"
import { issueCreditNote, sendCreditNote } from "../commands/credit-notes"
import { createInvoiceDraft, sendInvoice } from "../commands/invoices"
import { executeCommand } from "../execute"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

/** Regression tests for the fourth Codex review round. */
describeIfDatabase("round 4 review fixes", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function setup() {
    const org = await createTestOrganization()
    cleanups.push(async () => {
      // Credit notes restrict invoice deletion, so remove them before the organization cascade.
      await prisma.creditNote.deleteMany({ where: { organizationId: org.organizationId } })
      await org.cleanup()
    })
    const contact = await executeCommand(
      createContact,
      { name: "Acme", email: "billing@acme.test" },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    return { org, contactId: contact.result.id }
  }

  type Context = Awaited<ReturnType<typeof setup>>

  async function agentWith(context: Context, scopes: string[]) {
    const { secret } = await createAgentKey(context.org.actors.admin, {
      name: "Agent",
      mode: "approval_required",
      scopes: scopes as never,
    })
    return authenticateAgentSecret(secret)
  }

  /** A sent invoice of 2 x 100 Design + 3 x 50 Hosting, without tax: 350.00. */
  async function sentInvoice(context: Context) {
    const draft = await executeCommand(
      createInvoiceDraft,
      {
        contactId: context.contactId,
        dueDate: "2099-12-01",
        taxRate: 0,
        items: [
          { description: "Design", quantity: 2, unitPrice: 100 },
          { description: "Hosting", quantity: 3, unitPrice: 50 },
        ],
      },
      { actor: context.org.actors.admin }
    )
    if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
    const sent = await executeCommand(
      sendInvoice,
      { id: draft.result.id, allowSendWithoutEmail: true },
      { actor: context.org.actors.admin }
    )
    if (sent.status !== "completed") throw new Error(JSON.stringify(sent))
    const items = await prisma.invoiceItem.findMany({
      where: { invoiceId: draft.result.id },
      orderBy: { sortOrder: "asc" },
    })
    return { invoiceId: draft.result.id, number: draft.result.number, items }
  }

  describe("credit note issue approvals for selected lines", () => {
    it("shows the reviewer the selected lines and the amount they credit", async () => {
      const context = await setup()
      const invoice = await sentInvoice(context)
      const agent = await agentWith(context, ["creditNote:create", "invoice:read"])
      const [design, hosting] = invoice.items
      if (!design || !hosting) throw new Error("invoice lines missing")

      const queued = await executeCommand(
        issueCreditNote,
        {
          invoiceId: invoice.invoiceId,
          reason: "Unused hours",
          mode: "lines",
          lines: [
            { invoiceItemId: design.id, quantity: 1 },
            { invoiceItemId: hosting.id, quantity: 2 },
          ],
        },
        { actor: agent, clientRequestId: "credit-lines-1" }
      )
      if (queued.status !== "awaiting_approval") throw new Error(JSON.stringify(queued))

      const request = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: queued.approvalRequestId } })
      expect(request.summary).toBe(
        `Issue a credit note for 1 × Design, 2 × Hosting on invoice ${invoice.number} (200.00 USD): Unused hours`
      )
      expect(request.reviewContext).toMatchObject({
        details: { amount: "200.00", lines: "1 × Design; 2 × Hosting", total: "350.00" },
      })

      const decided = await decideApproval({
        approvalRequestId: queued.approvalRequestId,
        decider: context.org.actors.admin,
        decision: "approve",
      })
      expect(decided).toMatchObject({ status: "completed" })
      const creditNote = await prisma.creditNote.findFirstOrThrow({ where: { invoiceId: invoice.invoiceId } })
      expect(creditNote.totalGross.toFixed(2)).toBe("200.00")
    })

    it("refuses a reviewed line credit whose line changed before approval", async () => {
      const context = await setup()
      const invoice = await sentInvoice(context)
      const agent = await agentWith(context, ["creditNote:create", "invoice:read"])
      const [design] = invoice.items
      if (!design) throw new Error("invoice lines missing")

      const queued = await executeCommand(
        issueCreditNote,
        {
          invoiceId: invoice.invoiceId,
          reason: "Unused hours",
          mode: "lines",
          lines: [{ invoiceItemId: design.id, quantity: 1 }],
        },
        { actor: agent, clientRequestId: "credit-lines-2" }
      )
      if (queued.status !== "awaiting_approval") throw new Error(JSON.stringify(queued))
      // The line the reviewer saw is now described and priced differently.
      await prisma.invoiceItem.update({
        where: { id: design.id },
        data: { description: "Premium design", unitPriceNet: 150, unitPriceGross: 150, lineNet: 300, lineGross: 300 },
      })

      const decided = await decideApproval({
        approvalRequestId: queued.approvalRequestId,
        decider: context.org.actors.admin,
        decision: "approve",
      })
      expect(decided).toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
      expect(await prisma.creditNote.count({ where: { invoiceId: invoice.invoiceId } })).toBe(0)
    })

    it("refuses to queue a line credit that could never be issued", async () => {
      const context = await setup()
      const invoice = await sentInvoice(context)
      const agent = await agentWith(context, ["creditNote:create", "invoice:read"])
      const [design] = invoice.items
      if (!design) throw new Error("invoice lines missing")

      const queued = await executeCommand(
        issueCreditNote,
        {
          invoiceId: invoice.invoiceId,
          reason: "Too much",
          mode: "lines",
          lines: [{ invoiceItemId: design.id, quantity: 5 }],
        },
        { actor: agent, clientRequestId: "credit-lines-3" }
      )
      expect(queued).toMatchObject({ status: "failed", error: { tag: "InvalidState" } })
      expect(await prisma.approvalRequest.count({ where: { organizationId: context.org.organizationId } })).toBe(0)
    })
  })

  describe("credit note send approvals", () => {
    it("refuses to send after the customer was renamed since review", async () => {
      const context = await setup()
      const invoice = await sentInvoice(context)
      const issued = await executeCommand(
        issueCreditNote,
        { invoiceId: invoice.invoiceId, reason: "Refund", mode: "amount", amount: 50 },
        { actor: context.org.actors.admin }
      )
      if (issued.status !== "completed") throw new Error(JSON.stringify(issued))
      const agent = await agentWith(context, ["creditNote:send", "creditNote:read"])
      const queued = await executeCommand(
        sendCreditNote,
        { id: issued.result.id },
        { actor: agent, clientRequestId: "credit-send-1" }
      )
      if (queued.status !== "awaiting_approval") throw new Error(JSON.stringify(queued))

      // Same address, different addressee: the reviewer approved sending to "Acme".
      await executeCommand(updateContact, { id: context.contactId, name: "Acme Holdings" }, {
        actor: context.org.actors.admin,
      })

      const decided = await decideApproval({
        approvalRequestId: queued.approvalRequestId,
        decider: context.org.actors.admin,
        decision: "approve",
      })
      expect(decided).toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
    })
  })

  describe("approval recovery", () => {
    async function interruptedApproval() {
      const context = await setup()
      const draft = await executeCommand(
        createInvoiceDraft,
        {
          contactId: context.contactId,
          dueDate: "2099-12-01",
          taxRate: 0,
          items: [{ description: "X", quantity: 1, unitPrice: 100 }],
        },
        { actor: context.org.actors.admin }
      )
      if (draft.status !== "completed") throw new Error("draft failed")
      const agent = await agentWith(context, ["invoice:send", "invoice:read"])
      const queued = await executeCommand(
        sendInvoice,
        { id: draft.result.id, allowSendWithoutEmail: true },
        { actor: agent, clientRequestId: "send-1" }
      )
      if (queued.status !== "awaiting_approval") throw new Error("expected approval")
      await prisma.approvalRequest.update({
        where: { id: queued.approvalRequestId },
        data: { status: "approved", decidedByUserId: context.org.actors.admin.userId, decidedAt: new Date() },
      })
      return { context, queued, invoiceId: draft.result.id }
    }

    const approvedEvents = (organizationId: string, approvalRequestId: string) =>
      prisma.domainEvent.count({
        where: { organizationId, aggregateType: "approval", aggregateId: approvalRequestId, type: "approval.approved" },
      })

    const backdateReceipt = (commandId: string) =>
      prisma.commandReceipt.update({
        where: { id: commandId },
        data: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) },
      })

    it("records the approval once when an attempt that already recorded it is resumed", async () => {
      const { context, queued, invoiceId } = await interruptedApproval()
      // The first attempt recorded the approval, then stopped before the command finished.
      await prisma.$transaction((tx) =>
        appendEvents(tx, {
          organizationId: context.org.organizationId,
          actor: context.org.actors.admin,
          commandId: queued.commandId,
          approvedByUserId: context.org.actors.admin.userId,
          occurredAt: new Date(),
          events: [
            {
              aggregateType: "approval",
              aggregateId: queued.approvalRequestId,
              type: "approval.approved",
              payload: { commandType: "invoice.send", note: null },
            },
          ],
        })
      )
      await backdateReceipt(queued.commandId)

      const result = await recoverInterruptedApprovals({ organizationIds: [context.org.organizationId] })
      expect(result).toMatchObject({ recovered: 1, failed: 0 })
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("sent")
      expect(await approvedEvents(context.org.organizationId, queued.approvalRequestId)).toBe(1)
    })

    it("still records the approval when the interrupted attempt never did", async () => {
      const { context, queued } = await interruptedApproval()
      await backdateReceipt(queued.commandId)

      await recoverInterruptedApprovals({ organizationIds: [context.org.organizationId] })
      expect(await approvedEvents(context.org.organizationId, queued.approvalRequestId)).toBe(1)
    })
  })
})
