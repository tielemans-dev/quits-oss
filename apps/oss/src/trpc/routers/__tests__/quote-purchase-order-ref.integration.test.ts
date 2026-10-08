import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { documentViewSchema } from "@quits/contracts/document-view"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { executeIssuanceCommand } from "../../../application/issuance"
import { authenticateAgentSecret, createAgentKey } from "../../../domain/agent-keys"
import { decideApproval } from "../../../domain/approvals"
import { sendQuote } from "../../../domain/commands/quotes"
import { appRouter } from "../../router"

const cleanups: Array<() => Promise<void>> = []
beforeEach(() => { vi.stubEnv("RESEND_API_KEY", "") })
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  vi.unstubAllEnvs()
})
async function setup() {
  const org = await createTestOrganization()
  cleanups.push(org.cleanup)
  const api = appRouter.createCaller({ session: {
    user: { id: org.actors.admin.userId, email: "test@example.test", name: "Test" },
    session: { activeOrganizationId: org.organizationId },
  } } as never)
  const contact = await api.contacts.create({ name: "Buyer", email: "buyer@example.test" })
  const input = { contactId: contact.id, expiryDate: "2099-01-01", taxRate: "25",
    items: [{ description: "Work", quantity: "1", unitPrice: "100" }] }
  return { api, contact, input, org }
}

;(hasTestDatabase ? describe : describe.skip)("quote purchase order references", () => {
  for (const version of ["V1", "V2"] as const) {
    it(`round-trips ${version} references through revision-checked edits and the view`, async () => {
      const { api, input } = await setup()
      const create = version === "V1" ? api.quotes.create : api.quotes.createV2
      const update = version === "V1" ? api.quotes.update : api.quotes.updateV2
      const quote = await create({ ...input, purchaseOrderRef: "  PO-æøå  " })
      expect(quote.purchaseOrderRef).toBe("PO-æøå")
      const id = quote.id
      const before = await api.quotes.view({ id })
      expect(documentViewSchema.parse(before.view).buyer?.purchaseOrderRef).toBe("PO-æøå")
      expect(before.revision).toBe(0)
      await update({ id, expectedRevision: 0, purchaseOrderRef: " PO-updated " })
      await expect(update({ id, expectedRevision: 0, purchaseOrderRef: "stale" })).rejects.toMatchObject({ cause: { code: "stale_draft" } })
      await update({ id, expectedRevision: 1, notes: "Keep reference" })
      expect((await api.quotes.view({ id })).view.buyer?.purchaseOrderRef).toBe("PO-updated")
      await update({ id, expectedRevision: 2, purchaseOrderRef: "   " })
      expect(await api.quotes.view({ id })).toMatchObject({ revision: 3, view: { buyer: { purchaseOrderRef: null } } })
      await update({ id, expectedRevision: 3, purchaseOrderRef: "PO-restore" })
      await update({ id, expectedRevision: 4, purchaseOrderRef: null })
      expect((await prisma.quote.findUniqueOrThrow({ where: { id } })).purchaseOrderRef).toBeNull()
      for (const purchaseOrderRef of [undefined, null, "", "   "]) {
        const absent = await create({ ...input, purchaseOrderRef })
        expect(absent.purchaseOrderRef).toBeNull()
        expect((await api.quotes.view({ id: absent.id })).view.buyer?.purchaseOrderRef).toBeNull()
      }
    })

    it(`validates ${version} create and update without writing invalid references`, async () => {
      const { api, input, org } = await setup()
      const create = version === "V1" ? api.quotes.create : api.quotes.createV2
      const update = version === "V1" ? api.quotes.update : api.quotes.updateV2
      const quote = await create({ ...input, purchaseOrderRef: `  ${"Æ".repeat(200)}  ` })
      expect(quote.purchaseOrderRef).toBe("Æ".repeat(200))
      await update({ id: quote.id, expectedRevision: 0, purchaseOrderRef: `  ${"B".repeat(200)}  ` })
      const before = await api.quotes.view({ id: quote.id })
      for (const purchaseOrderRef of ["A".repeat(201), "\u200b", "\ufeffPO", "PO\n", "\t", "PO\u0000", "PO\uffff"]) {
        await expect(create({ ...input, purchaseOrderRef })).rejects.toMatchObject({ code: "BAD_REQUEST" })
        await expect(update({ id: quote.id, expectedRevision: 1, purchaseOrderRef })).rejects.toMatchObject({ code: "BAD_REQUEST" })
      }
      expect(await prisma.quote.count({ where: { organizationId: org.organizationId } })).toBe(1)
      expect(await api.quotes.view({ id: quote.id })).toEqual(before)
    })
  }

  it("locks the sent reference and carries it into a converted invoice", async () => {
    const { api, input, contact } = await setup()
    const quote = await api.quotes.createV2({ ...input, purchaseOrderRef: " PO-sent " })
    await api.quotes.send({ id: quote.id, allowSendWithoutEmail: true })
    await prisma.contact.update({ where: { id: contact.id }, data: { name: "Renamed buyer" } })
    for (const status of ["sent", "accepted", "rejected"]) {
      await prisma.quote.update({ where: { id: quote.id }, data: { status } })
      for (const update of [api.quotes.update, api.quotes.updateV2]) {
        await expect(update({ id: quote.id, purchaseOrderRef: "change" })).rejects.toMatchObject({ cause: { code: "not_draft" } })
      }
      expect(await api.quotes.view({ id: quote.id })).toMatchObject({ canEdit: false, view: { buyer: { purchaseOrderRef: "PO-sent", name: "Buyer" } } })
    }
    await prisma.quote.update({ where: { id: quote.id }, data: { status: "accepted" } })
    const invoice = await api.quotes.convertToInvoice({ id: quote.id })
    expect(invoice.purchaseOrderRef).toBe("PO-sent")
    expect((await api.invoices.view({ id: invoice.id })).view.buyer?.purchaseOrderRef).toBe("PO-sent")
  })

  it("shows the reference in approval details and invalidates a changed quote approval", async () => {
    const { api, input, org } = await setup()
    const quote = await api.quotes.createV2({ ...input, purchaseOrderRef: "PO-reviewed" })
    const { secret } = await createAgentKey(org.actors.admin, { name: "Sender", mode: "approval_required", scopes: ["quote:send"] })
    const actor = await authenticateAgentSecret(secret)
    const queued = await executeIssuanceCommand(sendQuote, { id: quote.id, allowSendWithoutEmail: true }, { actor, clientRequestId: "quote-send" })
    if (queued.status !== "awaiting_approval") throw new Error(JSON.stringify(queued))
    expect((await api.agents.approvals({ view: "pending" }))[0]?.reviewDetails).toMatchObject({ purchaseOrderRef: "PO-reviewed" })
    await api.quotes.updateV2({ id: quote.id, expectedRevision: 0, purchaseOrderRef: "PO-changed" })
    expect(await decideApproval({ approvalRequestId: queued.approvalRequestId, decider: org.actors.admin, decision: "approve" }))
      .toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe("draft")
  })
})
