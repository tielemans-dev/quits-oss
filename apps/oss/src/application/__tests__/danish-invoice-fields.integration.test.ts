import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { executeCommand } from "../../domain/execute"
import { createInvoiceDraft, sendInvoice } from "../../domain/commands/invoices"
import { createAgreementDraft } from "../../domain/commands/agreements"
import { createQuoteDraft, convertQuoteToInvoice } from "../../domain/commands/quotes"
import { createRecurringInvoice, runRecurringInvoiceNow } from "../../domain/commands/recurring"
import { createAgentKey, authenticateAgentSecret } from "../../domain/agent-keys"
import { decideApproval } from "../../domain/approvals"
import { issueDocument, reserveDocument, prepareDocument } from "../issuance"
import { setRuntimeExtensions } from "../../lib/runtime/extensions"
import { runOrganizationJobs } from "../../domain/scheduler"
import { composeInvoiceEmail } from "../../domain/documents/invoice-email"
import { serializePublicInvoiceSession } from "../../lib/payments/public-session"
import { issuedInvoiceSnapshot } from "../../domain/documents/issued-invoice"
import type { RenderInput } from "../../domain/documents/render-input"

const cleanups: Array<() => Promise<void>> = []
const policy = { sellerCountry: "DK", buyerCountries: ["DK"], currencies: ["DKK", "EUR"], standardVatRate: "25", requireCvr: true, requireBusinessBuyer: true, requireIdentity: true, requireSupplyDate: true, sellerVatRegistered: true }
const enable = () => setRuntimeExtensions([{ id: "synthetic-invoice-policy", resolveInvoiceIssuancePolicy: () => policy }])
beforeEach(() => { vi.stubEnv("RESEND_API_KEY", ""); vi.stubEnv("EMAIL_PROVIDER", ""); vi.stubEnv("SMTP_HOST", "") })
afterEach(async () => { setRuntimeExtensions([]); vi.unstubAllEnvs(); while (cleanups.length) await cleanups.pop()?.() })
async function setup() {
  const org = await createTestOrganization({ settings: { countryCode: "DK", currency: "DKK", locale: "da-DK", timezone: "Europe/Copenhagen", taxRegime: "eu_vat", pricesIncludeTax: true, companyName: "Synthetic Seller ApS" } })
  cleanups.push(org.cleanup)
  await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { companyAddress: "Testvej 1, 1000 København" } })
  await prisma.organizationTaxId.create({ data: { organizationId: org.organizationId, scheme: "cvr", value: "12345678", countryCode: "DK" } })
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Synthetic Buyer", email: "buyer@example.test", company: "Synthetic Buyer ApS", address: "Testvej 2", city: "København", zip: "1000", country: "DK" } })
  const input = { contactId: contact.id, dueDate: "2026-11-09", supplyDate: "2026-10-08", taxRate: 25, items: [{ description: "Synthetic consulting", quantity: 2, unitPrice: 625 }] }
  const draft = await executeCommand(createInvoiceDraft, input, { actor: org.actors.admin })
  if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
  return { org, contact, invoice: draft.result, input }
}
const issue = (context: Awaited<ReturnType<typeof setup>>, id = context.invoice.id) => issueDocument({ kind: "invoice", actor: context.org.actors.admin, commandInput: { id, supplyDate: "2026-10-08", allowSendWithoutEmail: true } })

;(hasTestDatabase ? describe : describe.skip)("Danish full invoice issuance", () => {
  it.each([false, true])("uses net PDF lines and freezes legal identity in policy mode %s", async restricted => {
    const context = await setup()
    if (restricted) enable()
    expect(await issue(context)).toMatchObject({ status: "completed" })
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: context.invoice.id }, include: { contact: true, items: { orderBy: { sortOrder: "asc" } } } })
    const candidate = await prisma.issuanceCandidate.findFirstOrThrow({ where: { documentId: row.id } })
    const render = candidate.renderInput as unknown as Extract<RenderInput, { kind: "invoice" }>
    expect(render.pdf.org).toMatchObject({ companyName: "Synthetic Seller ApS", companyAddress: "Testvej 1, 1000 København", taxIds: [{ scheme: "cvr", value: "12345678" }] })
    expect(render.pdf.invoice).toMatchObject({ number: row.number, supplyDate: "2026-10-08", pricesIncludeTax: false, subtotal: 1000, taxAmount: 250, total: 1250, items: [{ quantity: 2, unitPrice: 500, total: 1000 }] })
    expect(render.pdf.invoice.vatRows).toEqual([{ ratePercent: "25", net: "1000.00", tax: "250.00", gross: "1250.00" }])
    expect(issuedInvoiceSnapshot(row.issuanceSnapshot)).not.toBeNull()
    await prisma.orgSettings.update({ where: { organizationId: context.org.organizationId }, data: { companyName: "Changed Seller", companyAddress: "Changed address" } })
    await prisma.contact.update({ where: { id: context.contact.id }, data: { name: "Changed Buyer", address: "Changed buyer address" } })
    await prisma.organizationTaxId.updateMany({ where: { organizationId: context.org.organizationId }, data: { value: "87654321" } })
    const changed = await prisma.invoice.findUniqueOrThrow({ where: { id: row.id }, include: { contact: true, items: true } })
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: context.org.organizationId } })
    const email = composeInvoiceEmail({ invoice: { ...changed, number: changed.number! }, settings, to: "buyer@example.test", publicPaymentUrl: null }).message.html
    expect(email).toContain("Synthetic Seller ApS")
    expect(email).toContain("Synthetic Buyer")
    expect(email).toContain("CVR: 12345678")
    expect(email).not.toMatch(/Changed Seller|Changed Buyer|Changed address/)
    const session = serializePublicInvoiceSession({ invoice: changed, stripeEnabled: false, paymentState: "unpaid" }, "synthetic")
    expect(session.seller.name).toBe("Synthetic Seller ApS")
    expect(session.invoice.buyerSnapshot?.name).toBe("Synthetic Buyer")
    expect(session.invoice.items[0]?.unitPriceNet).toBe(500)
    expect(session.invoice.vatRows).toEqual(render.pdf.invoice.vatRows)
    expect(session.invoice.supplyDate).toBe("2026-10-08")
    expect((await prisma.issuanceCandidate.findUniqueOrThrow({ where: { id: candidate.id } })).renderInput).toEqual(candidate.renderInput)
  })
  it.each(["email", "manual"])("refuses invalid identity before numbering and jobs through %s", async path => {
    const context = await setup(); enable()
    await prisma.contact.update({ where: { id: context.contact.id }, data: { address: null } })
    const before = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: context.org.organizationId } })
    const result = await issueDocument({ kind: "invoice", actor: context.org.actors.admin, commandInput: { id: context.invoice.id, allowSendWithoutEmail: true }, options: { method: path as "email" | "manual" } })
    expect(result).toMatchObject({ status: "failed", error: { code: "invoice_issuance_policy" } })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: context.invoice.id } })).toMatchObject({ number: null, status: "draft" })
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: context.org.organizationId } })).invoiceNextNum).toBe(before.invoiceNextNum)
    expect(await prisma.job.count({ where: { organizationId: context.org.organizationId } })).toBe(0)
    expect(await prisma.artifactStaging.count({ where: { documentId: context.invoice.id } })).toBe(0)
  })
  it.each(["agreement", "quote"])("validates the agreed %s identity instead of changed settings", async origin => {
    const context = await setup()
    let invoiceId = context.invoice.id
    if (origin === "agreement") {
      const agreement = await executeCommand(createAgreementDraft, { contactId: context.contact.id, title: "Synthetic agreement", validUntil: "2026-11-09" }, { actor: context.org.actors.admin })
      if (agreement.status !== "completed") throw new Error(JSON.stringify(agreement))
      await prisma.invoice.update({ where: { id: invoiceId }, data: { agreementId: agreement.result.id } })
    } else {
      const quote = await executeCommand(createQuoteDraft, { ...context.input, dueDate: undefined, expiryDate: "2026-11-09" }, { actor: context.org.actors.admin })
      if (quote.status !== "completed") throw new Error(JSON.stringify(quote))
      await prisma.quote.update({ where: { id: quote.result.id }, data: { status: "accepted", number: "SYNTHETIC-Q-1" } })
      const converted = await executeCommand(convertQuoteToInvoice, { id: quote.result.id }, { actor: context.org.actors.admin })
      if (converted.status !== "completed") throw new Error(JSON.stringify(converted))
      invoiceId = converted.result.id
    }
    enable()
    await prisma.orgSettings.update({ where: { organizationId: context.org.organizationId }, data: { companyName: "Changed Seller", companyAddress: null } })
    await prisma.organizationTaxId.deleteMany({ where: { organizationId: context.org.organizationId } })
    await prisma.contact.update({ where: { id: context.contact.id }, data: { name: "Changed Buyer", address: null } })
    const issued = await issue(context, invoiceId)
    expect(issued, JSON.stringify(issued)).toMatchObject({ status: "completed" })
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(row.sellerSnapshot).toMatchObject({ companyName: "Synthetic Seller ApS", taxIds: [{ value: "12345678" }] })
    expect(row.buyerSnapshot).toMatchObject({ name: "Synthetic Buyer", address: "Testvej 2" })
  })
  it("rechecks policy before commit after an artifact was prepared", async () => {
    const context = await setup(); enable()
    const args = { kind: "invoice" as const, actor: context.org.actors.admin, commandInput: { id: context.invoice.id, supplyDate: "2026-10-08", allowSendWithoutEmail: true }, clientRequestId: "synthetic-policy-race" }
    const reserved = await reserveDocument(args)
    await prepareDocument(reserved.id)
    setRuntimeExtensions([{ id: "synthetic-policy", resolveInvoiceIssuancePolicy: () => ({ ...policy, sellerVatRegistered: false }) }])
    expect(await executeCommand(sendInvoice, args.commandInput, { actor: args.actor, clientRequestId: args.clientRequestId, issuanceStagingId: reserved.id })).toMatchObject({ status: "failed", error: { code: "invoice_issuance_policy" } })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: context.invoice.id } })).toMatchObject({ number: null, status: "draft" })
    expect(await prisma.issuanceCandidate.count({ where: { documentId: context.invoice.id } })).toBe(0)
    expect(await prisma.job.count({ where: { organizationId: context.org.organizationId } })).toBe(0)
  })
  it("enforces the invoice policy when an agent's approved send executes", async () => {
    const context = await setup(); enable()
    const key = await createAgentKey(context.org.actors.admin, { name: "Synthetic WS4 agent", mode: "approval_required", scopes: ["invoice:send"] })
    const actor = await authenticateAgentSecret(key.secret)
    const queued = await issueDocument({ kind: "invoice", actor, commandInput: { id: context.invoice.id, supplyDate: "2026-10-08", allowSendWithoutEmail: true }, clientRequestId: "synthetic-agent-policy" })
    if (queued.status !== "awaiting_approval") throw new Error(JSON.stringify(queued))
    setRuntimeExtensions([{ id: "synthetic-policy", resolveInvoiceIssuancePolicy: () => ({ ...policy, sellerVatRegistered: false }) }])
    const decided = await decideApproval({ approvalRequestId: queued.approvalRequestId, decider: context.org.actors.admin, decision: "approve" })
    expect(decided).toMatchObject({ status: "failed", error: { code: "invoice_issuance_policy" } })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: context.invoice.id } })).toMatchObject({ number: null, status: "draft" })
    expect(await prisma.job.count({ where: { organizationId: context.org.organizationId } })).toBe(0)
  })
  it("rejects unsupported recurring auto-send without taking an invoice number", async () => {
    const context = await setup(); enable()
    const recurring = await executeCommand(createRecurringInvoice, { name: "Synthetic schedule", contactId: context.contact.id, startDate: "2026-10-09", autoSend: true, taxRate: 0, items: context.input.items }, { actor: context.org.actors.admin })
    if (recurring.status !== "completed") throw new Error(JSON.stringify(recurring))
    vi.stubEnv("RESEND_API_KEY", "synthetic-no-network")
    expect(await executeCommand(runRecurringInvoiceNow, { id: recurring.result.id }, { actor: context.org.actors.admin })).toMatchObject({ status: "completed" })
    await runOrganizationJobs([context.org.organizationId])
    const generated = await prisma.invoice.findFirstOrThrow({ where: { recurringInvoiceId: recurring.result.id } })
    expect(generated).toMatchObject({ status: "draft", number: null, lastEmailAttemptCode: "invoice_issuance_policy" })
    expect(await prisma.issuanceCandidate.count({ where: { documentId: generated.id } })).toBe(0)
  })
})
