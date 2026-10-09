import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { documentViewSchema } from "@quits/contracts/document-view"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { executeIssuanceCommand } from "../../../application/issuance"
import { authenticateAgentSecret, createAgentKey } from "../../../domain/agent-keys"
import { decideApproval } from "../../../domain/approvals"
import { sendInvoice } from "../../../domain/commands/invoices"
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
  const contact = await api.contacts.create({ name: "EAN buyer", email: "buyer@example.test", country: "DK", peppolEndpointScheme: "0088", peppolEndpointId: "5790000000005" })
  const input = { contactId: contact.id, dueDate: "2099-01-01", supplyDate: "2026-10-08", taxRate: "25",
    items: [{ description: "Work", quantity: "1", unitPrice: "100" }] }
  return { api, contact, input, org }
}

;(hasTestDatabase ? describe : describe.skip)("invoice purchase order references", () => {
  for (const version of ["V1", "V2"] as const) {
    it(`enforces the trimmed reference length on ${version} create and update without saving invalid edits`, async () => {
      const { api, input, org } = await setup()
      const create = version === "V1" ? api.invoices.create : api.invoices.createV2
      const update = version === "V1" ? api.invoices.update : api.invoices.updateV2
      const reference = "Æ".repeat(200)
      const invoice = await create({ ...input, purchaseOrderRef: `  ${reference}  ` })
      expect(invoice.purchaseOrderRef).toBe(reference)
      await expect(create({ ...input, purchaseOrderRef: `${reference}A` })).rejects.toMatchObject({ code: "BAD_REQUEST" })
      expect(await prisma.invoice.count({ where: { organizationId: org.organizationId } })).toBe(1)
      await update({ id: invoice.id, expectedRevision: 0, purchaseOrderRef: `  ${"B".repeat(200)}  ` })
      const before = await api.invoices.view({ id: invoice.id })
      expect(before.view.buyer?.purchaseOrderRef).toBe("B".repeat(200))
      await expect(update({ id: invoice.id, expectedRevision: 1, purchaseOrderRef: "B".repeat(201) })).rejects.toMatchObject({ code: "BAD_REQUEST" })
      expect(await api.invoices.view({ id: invoice.id })).toEqual(before)
    })

    it(`refuses invisible and control characters on ${version} without saving`, async () => {
      const { api, input, org } = await setup()
      const create = version === "V1" ? api.invoices.create : api.invoices.createV2
      const update = version === "V1" ? api.invoices.update : api.invoices.updateV2
      const invoice = await create({ ...input, purchaseOrderRef: "PO-valid" })
      const before = await api.invoices.view({ id: invoice.id })
      for (const purchaseOrderRef of ["\u200b", "\ufeffPO-42", "PO-\u200d42", "PO-42\n", "\rPO-42", "\t", "PO-42\u007f", "PO-42\u0085"]) {
        await expect(create({ ...input, purchaseOrderRef })).rejects.toMatchObject({ code: "BAD_REQUEST" })
        await expect(update({ id: invoice.id, expectedRevision: 0, purchaseOrderRef })).rejects.toMatchObject({ code: "BAD_REQUEST" })
      }
      expect(await prisma.invoice.count({ where: { organizationId: org.organizationId } })).toBe(1)
      expect(await api.invoices.view({ id: invoice.id })).toEqual(before)
    })

    it(`round-trips ${version} create and revision-checked edits, including clear and omission`, async () => {
      const { api, input } = await setup()
      const create = version === "V1" ? api.invoices.create : api.invoices.createV2
      const update = version === "V1" ? api.invoices.update : api.invoices.updateV2
      const invoice = await create({ ...input, purchaseOrderRef: "  Ordre Æ-42 & <7>  " })
      expect(invoice.purchaseOrderRef).toBe("Ordre Æ-42 & <7>")
      const id = invoice.id
      const view = await api.invoices.view({ id })
      expect(documentViewSchema.parse(view.view).buyer?.purchaseOrderRef).toBe(invoice.purchaseOrderRef)
      expect(view.revision).toBe(0)
      await update({ id, expectedRevision: 0, purchaseOrderRef: " PO-43 " })
      await expect(update({ id, expectedRevision: 0, purchaseOrderRef: "stale" })).rejects.toMatchObject({ cause: { code: "stale_draft" } })
      expect((await api.invoices.view({ id })).view.buyer?.purchaseOrderRef).toBe("PO-43")
      await update({ id, expectedRevision: 1, notes: "Unrelated edit" })
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).purchaseOrderRef).toBe("PO-43")
      await update({ id, expectedRevision: 2, purchaseOrderRef: "   " })
      expect(await api.invoices.view({ id })).toMatchObject({ revision: 3, view: { buyer: { purchaseOrderRef: null } } })
      await update({ id, expectedRevision: 3, purchaseOrderRef: "PO-44" })
      await update({ id, expectedRevision: 4, purchaseOrderRef: null })
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).purchaseOrderRef).toBeNull()
      for (const purchaseOrderRef of [undefined, null, "", "   "]) {
        const empty = await create({ ...input, purchaseOrderRef })
        expect(empty.purchaseOrderRef).toBeNull()
        expect((await api.invoices.view({ id: empty.id })).view.buyer?.purchaseOrderRef).toBeNull()
      }
    })
  }

  for (const purchaseOrderRef of ["PO-issued", null]) {
    it(`refuses issued edits and reads the frozen ${purchaseOrderRef ?? "absent"} reference`, async () => {
      const { api, input, org } = await setup()
      const invoice = await api.invoices.createV2({ ...input, purchaseOrderRef })
      const id = invoice.id
      await api.invoices.send({ id, allowSendWithoutEmail: true })
      await expect(api.invoices.updateV2({ id, expectedRevision: 0, purchaseOrderRef: "changed" })).rejects.toMatchObject({ cause: { code: "not_draft" } })
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).purchaseOrderRef).toBe(purchaseOrderRef)
      const candidate = await prisma.issuanceCandidate.findFirstOrThrow({ where: { organizationId: org.organizationId, documentId: id, status: "published" } })
      expect(candidate.renderInput).toMatchObject({ snapshot: { purchaseOrderRef }, ubl: { orderReference: purchaseOrderRef } })
      // The immutable candidate is authoritative even if the current row is later corrupted.
      await prisma.invoice.update({ where: { id }, data: { purchaseOrderRef: "corrupted" } })
      expect(await api.invoices.view({ id })).toMatchObject({ canEdit: false, view: { buyer: { purchaseOrderRef } } })
    })
  }

  it("invalidates a pending send approval when the reference changes", async () => {
    const { api, input, org } = await setup()
    const invoice = await api.invoices.createV2({ ...input, purchaseOrderRef: "PO-reviewed" })
    const { secret } = await createAgentKey(org.actors.admin, { name: "Sender", mode: "approval_required", scopes: ["invoice:send"] })
    const actor = await authenticateAgentSecret(secret)
    const queued = await executeIssuanceCommand(sendInvoice, { id: invoice.id, allowSendWithoutEmail: true }, { actor, clientRequestId: "send-reviewed" })
    if (queued.status !== "awaiting_approval") throw new Error(JSON.stringify(queued))
    const review = (await api.agents.approvals({ view: "pending" })).find(request => request.id === queued.approvalRequestId)
    expect(review?.reviewDetails).toMatchObject({ purchaseOrderRef: "PO-reviewed" })
    await api.invoices.updateV2({ id: invoice.id, expectedRevision: 0, purchaseOrderRef: "PO-changed" })
    const decided = await decideApproval({ approvalRequestId: queued.approvalRequestId, decider: org.actors.admin, decision: "approve" })
    expect(decided).toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("draft")
  })

  it("carries a quote's existing order reference into the converted invoice", async () => {
    const { api, input } = await setup()
    const quote = await api.quotes.createV2({ ...input, expiryDate: "2099-01-01", purchaseOrderRef: "PO-quote" })
    await api.quotes.send({ id: quote.id, allowSendWithoutEmail: true })
    await prisma.quote.update({ where: { id: quote.id }, data: { status: "accepted" } })
    const invoice = await api.quotes.convertToInvoice({ id: quote.id })
    expect(invoice.purchaseOrderRef).toBe("PO-quote")
    expect((await api.invoices.view({ id: invoice.id })).view.buyer?.purchaseOrderRef).toBe("PO-quote")
  })

  it("sets both agreement-generated drafts and edits their references through draft locks", async () => {
    const { api, contact } = await setup()
    const agreement = await api.agreements.createDraft({ contactId: contact.id, title: "Project", validUntil: "2099-01-01", taxRate: "25",
      deliverables: [{ title: "Work", quantity: "1", unitPrice: "100" }, { title: "Deposit", quantity: "1", unitPrice: "25", isDeposit: true }] })
    await prisma.agreement.update({ where: { id: agreement.id }, data: { status: "accepted" } })
    await prisma.deliverable.updateMany({ where: { agreementId: agreement.id }, data: { status: "accepted" } })
    const created = await api.invoices.createFromDeliverables({ agreementId: agreement.id, deliverableIds: agreement.deliverables.map(line => line.id), purchaseOrderRef: " PO-agreement " })
    for (const id of [created.saleInvoiceId!, created.prepaymentInvoiceId!]) {
      expect((await api.invoices.view({ id })).view.buyer?.purchaseOrderRef).toBe("PO-agreement")
      await api.invoices.updateV2({ id, expectedRevision: 0, purchaseOrderRef: " PO-edited " })
      await expect(api.invoices.updateV2({ id, expectedRevision: 0, purchaseOrderRef: "stale" })).rejects.toMatchObject({ cause: { code: "stale_draft" } })
      await api.invoices.update({ id, expectedRevision: 1, notes: "Keep reference" })
      expect((await api.invoices.view({ id })).view.buyer?.purchaseOrderRef).toBe("PO-edited")
      await api.invoices.update({ id, expectedRevision: 2, purchaseOrderRef: " " })
      expect(await api.invoices.view({ id })).toMatchObject({ revision: 3, view: { buyer: { purchaseOrderRef: null } } })
    }
  })
})
