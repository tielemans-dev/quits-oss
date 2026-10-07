import { executeIssuanceCommand } from "../../application/issuance"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { authenticateAgentSecret, createAgentKey } from "../agent-keys"
import { lockedContact } from "../approval-contexts"
import { decideApproval, recoverInterruptedApprovals } from "../approvals"
import { createContact, updateContact } from "../commands/contacts"
import { createInvoiceDraft, sendInvoice } from "../commands/invoices"
import { createRecurringInvoice, runRecurringInvoiceNow } from "../commands/recurring"

import { Command, Db, type CommandScope } from "../services"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

/** Regression tests for the third Codex review round. */
describeIfDatabase("round 3 review fixes", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function setup() {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    const contact = await executeIssuanceCommand(
      createContact,
      { name: "Acme", email: "billing@acme.test" },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    return { org, contactId: contact.result.id }
  }

  async function agentWith(org: Awaited<ReturnType<typeof setup>>["org"], scopes: string[]) {
    const { secret, key } = await createAgentKey(org.actors.admin, {
      name: "Agent",
      mode: "approval_required",
      scopes: scopes as never,
    })
    return { agent: await authenticateAgentSecret(secret), keyId: key.id }
  }

  describe("recurring run approvals", () => {
    async function queuedRunNow() {
      const { org, contactId } = await setup()
      const schedule = await executeIssuanceCommand(
        createRecurringInvoice,
        {
          name: "Retainer",
          contactId,
          items: [{ description: "Retainer", quantity: 1, unitPrice: 100 }],
          startDate: "2099-01-01",
          notes: "Thanks!",
          // Running a schedule early only needs approval when it sends the invoice.
          autoSend: true,
        },
        { actor: org.actors.admin }
      )
      if (schedule.status !== "completed") throw new Error(JSON.stringify(schedule))
      const { agent } = await agentWith(org, ["recurring:update", "recurring:read"])
      const queued = await executeIssuanceCommand(
        runRecurringInvoiceNow,
        { id: schedule.result.id },
        { actor: agent, clientRequestId: "run-1" }
      )
      if (queued.status !== "awaiting_approval") throw new Error(JSON.stringify(queued))
      return { org, scheduleId: schedule.result.id, queued }
    }

    it("shows the run limit, payment terms and notes to the reviewer", async () => {
      const { queued } = await queuedRunNow()
      const request = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: queued.approvalRequestId } })
      expect(request.reviewContext).toMatchObject({
        details: { endsAt: null, remainingRuns: null, paymentTerms: "Due in 14 days", notes: "Thanks!" },
      })
    })

    it.each([
      ["end date", { endsAt: new Date("2099-06-01T00:00:00Z") }],
      ["remaining runs", { remainingRuns: 1 }],
      ["payment terms", { dueInDays: 60 }],
      ["notes", { notes: "Different terms apply" }],
      ["name", { name: "Renamed" }],
    ])("refuses to run after the %s changed since review", async (_label, change) => {
      const { org, scheduleId, queued } = await queuedRunNow()
      await prisma.recurringInvoice.update({ where: { id: scheduleId }, data: change })

      const decided = await decideApproval({
        approvalRequestId: queued.approvalRequestId,
        decider: org.actors.admin,
        decision: "approve",
      })
      expect(decided).toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
      expect(await prisma.invoice.count({ where: { recurringInvoiceId: scheduleId } })).toBe(0)
    })

    it("refuses to run after the customer was renamed since review", async () => {
      const { org, scheduleId, queued } = await queuedRunNow()
      const schedule = await prisma.recurringInvoice.findUniqueOrThrow({ where: { id: scheduleId } })
      await executeIssuanceCommand(updateContact, { id: schedule.contactId, name: "Acme Holdings" }, { actor: org.actors.admin })

      const decided = await decideApproval({
        approvalRequestId: queued.approvalRequestId,
        decider: org.actors.admin,
        decision: "approve",
      })
      expect(decided).toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
    })
  })

  describe("invoice send approvals", () => {
    async function queuedSend() {
      const { org, contactId } = await setup()
      const draft = await executeIssuanceCommand(
        createInvoiceDraft,
        { contactId, dueDate: "2099-12-01", taxRate: 0, items: [{ description: "X", quantity: 1, unitPrice: 100 }] },
        { actor: org.actors.admin }
      )
      if (draft.status !== "completed") throw new Error("draft failed")
      const { agent } = await agentWith(org, ["invoice:send", "invoice:read"])
      const queued = await executeIssuanceCommand(
        sendInvoice,
        { id: draft.result.id, allowSendWithoutEmail: true },
        { actor: agent, clientRequestId: "send-1" }
      )
      if (queued.status !== "awaiting_approval") throw new Error("expected approval")
      return { org, contactId, invoiceId: draft.result.id, queued }
    }

    it("refuses to send after the invoice moved to another contact with the same address", async () => {
      const { org, invoiceId, queued } = await queuedSend()
      const other = await executeIssuanceCommand(
        createContact,
        { name: "Someone Else", email: "billing@acme.test" },
        { actor: org.actors.admin }
      )
      if (other.status !== "completed") throw new Error("contact failed")
      await prisma.invoice.update({ where: { id: invoiceId }, data: { contactId: other.result.id } })

      const decided = await decideApproval({
        approvalRequestId: queued.approvalRequestId,
        decider: org.actors.admin,
        decision: "approve",
      })
      expect(decided).toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("draft")
    })

    it("refuses to send after the customer was renamed since review", async () => {
      const { org, contactId, invoiceId, queued } = await queuedSend()
      await executeIssuanceCommand(updateContact, { id: contactId, name: "Acme Holdings" }, { actor: org.actors.admin })

      const decided = await decideApproval({
        approvalRequestId: queued.approvalRequestId,
        decider: org.actors.admin,
        decision: "approve",
      })
      expect(decided).toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("draft")
    })
  })

  it("does not block drafts for a contact while an approval holds the contact lock", async () => {
    const { org, contactId } = await setup()
    let release: () => void = () => undefined
    let locked: () => void = () => undefined
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve
    })
    const holder = prisma.$transaction(
      async (tx) => {
        const scope = { organizationId: org.organizationId } as CommandScope
        await Effect.runPromise(
          lockedContact(contactId).pipe(Effect.provideService(Db, tx), Effect.provideService(Command, scope))
        )
        locked()
        await new Promise<void>((resolve) => {
          release = resolve
        })
      },
      { timeout: 20_000 }
    )
    await lockTaken
    try {
      const draft = await Promise.race([
        executeIssuanceCommand(
          createInvoiceDraft,
          { contactId, dueDate: "2099-12-01", taxRate: 0, items: [{ description: "X", quantity: 1, unitPrice: 1 }] },
          { actor: org.actors.admin }
        ),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 3000)),
      ])
      expect(draft).toMatchObject({ status: "completed" })
    } finally {
      release()
      await holder
    }
  })

  it("recovers a stuck approval even behind many older decided requests", async () => {
    const { org, contactId } = await setup()
    const draft = await executeIssuanceCommand(
      createInvoiceDraft,
      { contactId, dueDate: "2099-12-01", taxRate: 0, items: [{ description: "X", quantity: 1, unitPrice: 100 }] },
      { actor: org.actors.admin }
    )
    if (draft.status !== "completed") throw new Error("draft failed")
    const { agent, keyId } = await agentWith(org, ["invoice:send", "invoice:read"])
    const queued = await executeIssuanceCommand(
      sendInvoice,
      { id: draft.result.id, allowSendWithoutEmail: true },
      { actor: agent, clientRequestId: "send-stuck" }
    )
    if (queued.status !== "awaiting_approval") throw new Error("expected approval")

    // 600 older, fully finished decisions that a window over decided requests would fill up on.
    const old = new Date("2020-01-01T00:00:00Z")
    const history = Array.from({ length: 600 }, (_, index) => `old-${org.organizationId}-${index}`)
    await prisma.commandReceipt.createMany({
      data: history.map((id) => ({
        id,
        organizationId: org.organizationId,
        actorKey: `agent:${keyId}`,
        clientRequestId: id,
        commandType: "invoice.send",
        status: "completed",
        updatedAt: old,
      })),
    })
    await prisma.approvalRequest.createMany({
      data: history.map((id) => ({
        organizationId: org.organizationId,
        agentKeyId: keyId,
        commandReceiptId: id,
        commandType: "invoice.send",
        command: {},
        summary: "old",
        status: "approved",
        decidedByUserId: org.actors.admin.userId,
        decidedAt: old,
        expiresAt: old,
      })),
    })

    await prisma.approvalRequest.update({
      where: { id: queued.approvalRequestId },
      data: { status: "approved", decidedByUserId: org.actors.admin.userId, decidedAt: new Date() },
    })
    await prisma.commandReceipt.update({
      where: { id: queued.commandId },
      data: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) },
    })

    const result = await recoverInterruptedApprovals({ organizationIds: [org.organizationId] })
    expect(result).toMatchObject({ recovered: 1, failed: 0 })
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: draft.result.id } })).status).toBe("sent")
  })
})
