import { executeIssuanceCommand } from "../../application/issuance"
import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { authenticateAgentSecret, createAgentKey, revokeAgentKey } from "../agent-keys"
import { recoverInterruptedApprovals } from "../approvals"
import { createContact } from "../commands/contacts"
import { createInvoiceDraft, sendInvoice, updateInvoiceDraft } from "../commands/invoices"
import { recordPayment, voidPayment } from "../commands/payments"


const describeIfDatabase = hasTestDatabase ? describe : describe.skip

/** Regression tests for the second Codex review round. */
describeIfDatabase("round 2 review fixes", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function setup(settings: { currency?: string; timezone?: string } = {}) {
    const org = await createTestOrganization({ settings })
    cleanups.push(org.cleanup)
    const contact = await executeIssuanceCommand(
      createContact,
      { name: "Acme", email: "billing@acme.test" },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    return { org, contactId: contact.result.id }
  }

  it("keeps the nominal VAT rate when only the currency changes", async () => {
    const { org, contactId } = await setup()
    const draft = await executeIssuanceCommand(
      createInvoiceDraft,
      {
        contactId,
        dueDate: "2099-12-01",
        currency: "JPY",
        taxRate: 25,
        items: [{ description: "Consulting", quantity: 1, unitPrice: 105 }],
      },
      { actor: org.actors.admin }
    )
    if (draft.status !== "completed") throw new Error("draft failed")
    expect(draft.result.totalTax.toNumber()).toBe(26)

    const changed = await executeIssuanceCommand(
      updateInvoiceDraft,
      { id: draft.result.id, currency: "DKK" },
      { actor: org.actors.admin }
    )
    if (changed.status !== "completed") throw new Error(JSON.stringify(changed))
    expect(changed.result.totalTax.toNumber()).toBe(26.25)
    expect(changed.result.items[0]?.taxRate.toNumber()).toBe(25)
  })

  it("shows the payment's calendar day in void approvals", async () => {
    const { org, contactId } = await setup({ timezone: "Europe/Copenhagen" })
    const draft = await executeIssuanceCommand(
      createInvoiceDraft,
      { contactId, dueDate: "2099-12-01", taxRate: 0, items: [{ description: "X", quantity: 1, unitPrice: 100 }] },
      { actor: org.actors.admin }
    )
    if (draft.status !== "completed") throw new Error("draft failed")
    await executeIssuanceCommand(sendInvoice, { id: draft.result.id, allowSendWithoutEmail: true }, { actor: org.actors.admin })
    const paid = await executeIssuanceCommand(
      recordPayment,
      { invoiceId: draft.result.id, amount: 100, paidAt: "2026-01-15", method: "bank_transfer" },
      { actor: org.actors.admin }
    )
    if (paid.status !== "completed") throw new Error("payment failed")

    const { secret } = await createAgentKey(org.actors.admin, {
      name: "Bookkeeper",
      mode: "approval_required",
      scopes: ["payment:void", "payment:read"],
    })
    const agent = await authenticateAgentSecret(secret)
    const queued = await executeIssuanceCommand(
      voidPayment,
      { paymentId: paid.result.payment.id, reason: "Duplicate" },
      { actor: agent, clientRequestId: "void-1" }
    )
    if (queued.status !== "awaiting_approval") throw new Error("expected approval")

    const request = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: queued.approvalRequestId } })
    expect(request.reviewContext).toMatchObject({ details: { paidAt: "2026-01-15" } })
  })

  describe("interrupted approvals", () => {
    async function queuedSend() {
      const { org, contactId } = await setup()
      const draft = await executeIssuanceCommand(
        createInvoiceDraft,
        { contactId, dueDate: "2099-12-01", taxRate: 0, items: [{ description: "X", quantity: 1, unitPrice: 100 }] },
        { actor: org.actors.admin }
      )
      if (draft.status !== "completed") throw new Error("draft failed")
      const { secret, key } = await createAgentKey(org.actors.admin, {
        name: "Sender",
        mode: "approval_required",
        scopes: ["invoice:send", "invoice:read"],
      })
      const agent = await authenticateAgentSecret(secret)
      const queued = await executeIssuanceCommand(
        sendInvoice,
        { id: draft.result.id, allowSendWithoutEmail: true },
        { actor: agent, clientRequestId: "send-1" }
      )
      if (queued.status !== "awaiting_approval") throw new Error("expected approval")
      return { org, invoiceId: draft.result.id, queued, keyId: key.id }
    }

    it("finishes an approval interrupted after the decision on the next scheduler tick", async () => {
      const { org, invoiceId, queued } = await queuedSend()
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
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("sent")
      const receipt = await prisma.commandReceipt.findUniqueOrThrow({ where: { id: queued.commandId } })
      expect(receipt.status).toBe("completed")
    })

    it("lets an interrupted revocation be finished by revoking again", async () => {
      const { org, queued, keyId } = await queuedSend()
      // Simulate a revocation whose cleanup never ran.
      await prisma.agentKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } })

      await revokeAgentKey(org.actors.admin, keyId)

      const receipt = await prisma.commandReceipt.findUniqueOrThrow({ where: { id: queued.commandId } })
      expect(receipt.status).toBe("expired")
    })
  })
})
