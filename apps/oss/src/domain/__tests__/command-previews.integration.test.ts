import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { executeIssuanceCommand as execute } from "../../application/issuance"
import { getDocumentRenderer, setRuntimeServices } from "../../lib/runtime/services"
import { presentCommandPreview } from "../../application/command-preview"
import { createContact } from "../commands/contacts"
import { createInvoiceDraft, updateInvoiceDraft, sendInvoice } from "../commands/invoices"
import { createAgreementDraft } from "../commands/agreements"
import { issueAgreement, sendAgreement, recordAgreementAcceptance } from "../commands/agreement-lifecycle"
import { recordPayment } from "../commands/payments"
import { createAgentKey, resolveAgentActorById, revokeAgentKey } from "../agent-keys"
import { decideApproval } from "../approvals"
import { previewCommand } from "../preview"
import { runAgentTool } from "../agent-tools/mcp"
import { getAgentTool } from "../agent-tools/registry"

const describeWithDatabase = hasTestDatabase ? describe : describe.skip

describeWithDatabase("command consequence previews", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })
  async function setup() {
    const org = await createTestOrganization(); cleanups.push(org.cleanup)
    const contact = await execute(createContact, { name: "Customer A", email: "customer-a@example.test" }, { actor: org.actors.admin })
    if (contact.status !== "completed") throw new Error("contact setup failed")
    const draft = await execute(createInvoiceDraft, { contactId: contact.result.id, dueDate: "2099-01-01", items: [{ description: "Service", quantity: 1, unitPrice: 100 }], taxRate: 25 }, { actor: org.actors.admin })
    if (draft.status !== "completed") throw new Error("draft setup failed")
    return { org, contact: contact.result, invoice: draft.result }
  }
  async function agent(org: Awaited<ReturnType<typeof createTestOrganization>>, mode: "full_access" | "approval_required" = "approval_required") {
    const { key } = await createAgentKey(org.actors.admin, { name: "Preview agent", mode, scopes: ["invoice:send", "payment:create", "agreement:send"] })
    return resolveAgentActorById(key.id, { allowRevoked: false })
  }
  async function evidence(organizationId: string) {
    const scope = { where: { organizationId } }
    return Promise.all([
      prisma.invoice.count(scope), prisma.payment.count(scope), prisma.artifactStaging.count(scope),
      prisma.issuanceCandidate.count(scope), prisma.job.count(scope), prisma.commandReceipt.count(scope),
      prisma.approvalRequest.count(scope), prisma.domainEvent.count(scope),
      prisma.orgSettings.findUnique({ where: { organizationId }, select: { invoiceNextNum: true, agreementNextNum: true } }),
    ])
  }
  it("previews exact facts and rendering repeatedly without persisted effects", async () => {
    const { org, invoice } = await setup(), actor = await agent(org)
    const input = { id: invoice.id, allowSendWithoutEmail: true }, before = await evidence(org.organizationId)
    const first = await previewCommand(sendInvoice, input, { actor })
    expect((await previewCommand(sendInvoice, input, { actor })).previewVersion).toBe(first.previewVersion)
    expect(invoice.number).toBeNull()
    expect(first.review.documentPreview?.number).toBe("draft")
    expect(first.review.details).toMatchObject({ recipient: "customer-a@example.test", total: "125.00", currency: "USD", documentId: invoice.id })
    expect(first.review.consequences).toMatchObject({ records: [{ kind: "invoice_issue", documentId: invoice.id }], messages: [], manualSteps: ["share_document"] })
    const presented = await presentCommandPreview(first, true)
    expect(presented.document?.mimeType).toBe("application/pdf")
    expect(presented.review).not.toHaveProperty("documentPreview")
    expect(await evidence(org.organizationId)).toEqual(before)
  })
  it("reports missing rendering as unavailable instead of returning a non-PDF body", async () => {
    const { org, invoice } = await setup()
    const preview = await previewCommand(sendInvoice, { id: invoice.id, allowSendWithoutEmail: true }, { actor: org.actors.admin })
    const renderer = getDocumentRenderer()
    setRuntimeServices({ documentRenderer: undefined })
    try {
      await expect(presentCommandPreview(preview, true)).rejects.toMatchObject({ code: "renderer_unavailable" })
    } finally { setRuntimeServices({ documentRenderer: renderer }) }
  })
  it.each(["amount", "recipient", "payment details"])("rejects a stale invoice approval after changing %s without issuance effects", async change => {
    const { org, invoice, contact } = await setup(), actor = await agent(org)
    const queued = await execute(sendInvoice, { id: invoice.id, allowSendWithoutEmail: true }, { actor, clientRequestId: `stale-${change}` })
    if (queued.status !== "awaiting_approval") throw new Error(`not queued: ${JSON.stringify(queued)}`)
    if (change === "amount") await execute(updateInvoiceDraft, { id: invoice.id, items: [{ description: "Changed service", quantity: 1, unitPrice: 160 }] }, { actor: org.actors.admin })
    if (change === "recipient") await prisma.contact.update({ where: { id: contact.id }, data: { email: "customer-b@example.test" } })
    if (change === "payment details") await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { paymentNote: "Changed account" } })
    expect(await decideApproval({ approvalRequestId: queued.approvalRequestId, decider: org.actors.admin, decision: "approve" })).toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
    expect(await prisma.invoice.findUnique({ where: { id: invoice.id } })).toMatchObject({ status: "draft" })
    expect(await prisma.artifactStaging.count({ where: { organizationId: org.organizationId } })).toBe(0)
    expect(await prisma.job.count({ where: { organizationId: org.organizationId } })).toBe(0)
  })
  it("binds full-access previews to input, executes immediately and replays duplicate clientRequestId", async () => {
    const { org, invoice } = await setup(), actor = await agent(org, "full_access")
    const input = { id: invoice.id, allowSendWithoutEmail: true }, preview = await previewCommand(sendInvoice, input, { actor })
    expect((await execute(sendInvoice, { ...input, allowSendWithoutEmail: false }, { actor, expectedPreviewVersion: preview.previewVersion })).status).toBe("failed")
    const opts = { actor, clientRequestId: "same-issue", expectedPreviewVersion: preview.previewVersion }
    const result = await execute(sendInvoice, input, opts)
    expect(result.status).toBe("completed")
    expect(await execute(sendInvoice, input, opts)).toEqual(result)
    expect(await prisma.approvalRequest.count({ where: { organizationId: org.organizationId } })).toBe(0)
    expect(await prisma.artifactStaging.count({ where: { organizationId: org.organizationId } })).toBe(1)
  })
  it("does not invalidate an unnumbered draft review when another invoice consumes a number", async () => {
    const { org, invoice } = await setup()
    const input = { id: invoice.id, allowSendWithoutEmail: true }
    const preview = await previewCommand(sendInvoice, input, { actor: org.actors.admin })
    await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { invoiceNextNum: { increment: 1 } } })
    expect((await previewCommand(sendInvoice, input, { actor: org.actors.admin })).previewVersion).toBe(preview.previewVersion)
    expect((await execute(sendInvoice, input, { actor: org.actors.admin, expectedPreviewVersion: preview.previewVersion })).status).toBe("completed")
  })
  it("uses the current agent mode when executing a previously full-access preview", async () => {
    const { org, invoice } = await setup(), actor = await agent(org, "full_access")
    const input = { id: invoice.id, allowSendWithoutEmail: true }
    const preview = await previewCommand(sendInvoice, input, { actor })
    await prisma.agentKey.update({ where: { id: actor.agentKeyId }, data: { mode: "approval_required" } })
    expect((await execute(sendInvoice, input, { actor, expectedPreviewVersion: preview.previewVersion })).status).toBe("awaiting_approval")
    expect(await prisma.invoice.findUnique({ where: { id: invoice.id } })).toMatchObject({ status: "draft", number: null })
  })
  it("shows payment allocation, ignores unrelated note edits and rejects changed balances", async () => {
    const { org, invoice } = await setup()
    await execute(sendInvoice, { id: invoice.id, allowSendWithoutEmail: true }, { actor: org.actors.admin })
    const input = { invoiceId: invoice.id, amount: 25, paidAt: "2026-01-15", method: "bank_transfer" }
    const before = await evidence(org.organizationId), preview = await previewCommand(recordPayment, input, { actor: org.actors.admin })
    expect(preview.review.details).toMatchObject({ amount: "25.00", currency: "USD", balanceDue: "125.00", balanceAfter: "100.00", invoiceId: invoice.id })
    expect(preview.review.consequences?.messages).toEqual([])
    expect(await evidence(org.organizationId)).toEqual(before)
    await prisma.invoice.update({ where: { id: invoice.id }, data: { notes: "Unrelated note" } })
    expect((await previewCommand(recordPayment, input, { actor: org.actors.admin })).previewVersion).toBe(preview.previewVersion)
    expect((await execute(recordPayment, input, { actor: org.actors.admin, expectedPreviewVersion: preview.previewVersion })).status).toBe("completed")
    expect(await execute(recordPayment, input, { actor: org.actors.admin, expectedPreviewVersion: preview.previewVersion })).toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
    expect(await prisma.payment.count({ where: { organizationId: org.organizationId } })).toBe(1)
  })
  it("denies cross-organization, revoked-key and revoked-scope access", async () => {
    const { org, invoice } = await setup(), other = await createTestOrganization(); cleanups.push(other.cleanup)
    await expect(previewCommand(sendInvoice, { id: invoice.id, allowSendWithoutEmail: true }, { actor: other.actors.admin })).rejects.toMatchObject({ _tag: "NotFound" })
    const actor = await agent(org), tool = getAgentTool(actor, "command_preview")
    await prisma.agentKey.update({ where: { id: actor.agentKeyId }, data: { scopes: ["payment:create"] } })
    await expect(tool.run({ actor }, { commandType: "invoice.send", command: { id: invoice.id }, includeDocument: false })).rejects.toMatchObject({ _tag: "Forbidden" })
    await revokeAgentKey(org.actors.admin, actor.agentKeyId)
    await expect(previewCommand(sendInvoice, { id: invoice.id }, { actor })).rejects.toMatchObject({ _tag: "Forbidden" })
  })
  it("preserves an OAuth-authenticated actor's narrower scopes through command_preview", async () => {
    const { org, invoice } = await setup()
    const { key } = await createAgentKey(org.actors.admin, {
      name: "OAuth installation", mode: "full_access", scopes: ["invoice:read", "invoice:send"],
    })
    const installation = await resolveAgentActorById(key.id, { allowRevoked: false })
    // MCP #31 authenticateMcpAccessToken returns the live installation intersected with
    // the token grant. This is its output contract, not an OAuth verifier substitute.
    const actor = { ...installation, scopes: installation.scopes.filter(scope => scope === "invoice:read") }
    const before = await evidence(org.organizationId)
    expect(await runAgentTool(actor, "command_preview", {
      commandType: "invoice.send", command: { id: invoice.id, allowSendWithoutEmail: true }, includeDocument: false,
    })).toMatchObject({ ok: false, error: { tag: "Forbidden" } })
    expect(await evidence(org.organizationId)).toEqual(before)
    expect(await runAgentTool(installation, "command_preview", {
      commandType: "invoice.send", command: { id: invoice.id, allowSendWithoutEmail: true }, includeDocument: false,
    })).toMatchObject({ ok: true })
  })
  it.each(["read_only", "membership_removed", "expired"])("refreshes live agent restrictions: %s", async restriction => {
    const { org, invoice } = await setup(), actor = await agent(org, "full_access")
    if (restriction === "read_only") await prisma.agentKey.update({ where: { id: actor.agentKeyId }, data: { mode: "read_only" } })
    if (restriction === "expired") await prisma.agentKey.update({ where: { id: actor.agentKeyId }, data: { expiresAt: new Date(0) } })
    if (restriction === "membership_removed") await prisma.member.deleteMany({ where: { organizationId: org.organizationId, userId: org.actors.admin.userId } })
    const before = await evidence(org.organizationId)
    expect(await runAgentTool(actor, "command_preview", {
      commandType: "invoice.send", command: { id: invoice.id, allowSendWithoutEmail: true }, includeDocument: false,
    })).toMatchObject({ ok: false, error: { tag: "Forbidden" } })
    expect(await evidence(org.organizationId)).toEqual(before)
  })
  it("distinguishes future eligibility, sale drafts and blocked prepayment drafts without collection", async () => {
    const { org, contact } = await setup()
    const draft = await execute(createAgreementDraft, { contactId: contact.id, title: "Scheduled work", validUntil: "2099-01-01", deliverables: [{ title: "Service", quantity: 1, unitPrice: 100 }, { title: "Schedule", quantity: 1, unitPrice: 50, isDeposit: true }] }, { actor: org.actors.admin })
    if (draft.status !== "completed") throw new Error("agreement setup failed")
    const beforeIssuance = await evidence(org.organizationId)
    await expect(previewCommand(sendAgreement, { id: draft.result.id }, { actor: org.actors.admin })).rejects.toMatchObject({ code: "email_unavailable" })
    expect(await evidence(org.organizationId)).toEqual(beforeIssuance)
    const preview = await previewCommand(issueAgreement, { id: draft.result.id, recipient: contact.email }, { actor: org.actors.admin })
    expect(preview.review.consequences?.schedule).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "prepayment", state: "future_eligibility", invoiceId: null }), expect.objectContaining({ kind: "sale", state: "future_eligibility" })]))
    expect(preview.review.consequences?.manualSteps).toContain("collect_payment")
    expect(await prisma.agreement.findUnique({ where: { id: draft.result.id } })).toMatchObject({ number: null, status: "draft" })
    expect((await execute(issueAgreement, { id: draft.result.id, recipient: contact.email }, { actor: org.actors.admin })).status).toBe("completed")
    for (const purpose of ["sale", "prepayment"] as const) await prisma.invoice.create({ data: { organizationId: org.organizationId, contactId: contact.id, agreementId: draft.result.id, number: `DRAFT-${purpose}`, purpose, dueDate: new Date("2099-01-01"), subtotalNet: 50, totalTax: 0, totalGross: 50 } })
    const before = await evidence(org.organizationId)
    const acceptance = await previewCommand(recordAgreementAcceptance, { id: draft.result.id, acceptedByName: "Customer A", evidenceNote: "Private evidence" }, { actor: org.actors.admin })
    expect(acceptance.review.consequences?.schedule).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "sale", state: "draft" }), expect.objectContaining({ kind: "prepayment", state: "draft" })]))
    expect(acceptance.review.consequences?.records).toEqual([expect.objectContaining({ kind: "agreement_acceptance" })])
    expect(acceptance.review.consequences?.messages.map(message => message.recipient)).toContain(contact.email)
    expect(JSON.stringify(acceptance.review.preview)).not.toContain("Private evidence")
    expect(await evidence(org.organizationId)).toEqual(before)
  })
})
