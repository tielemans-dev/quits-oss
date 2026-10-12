// MOCK: synthetic test organizations, parties, document amounts and rates only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "../../../generated/prisma/client"
import { parseSellerSnapshot } from "@quits/contracts/documents"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createAgreementDraft } from "../../domain/commands/agreements"
import { sendAgreement, issueAgreement } from "../../domain/commands/agreement-lifecycle"
import { createQuoteDraft, sendQuote } from "../../domain/commands/quotes"
import { authenticateAgentSecret, createAgentKey } from "../../domain/agent-keys"
import { decideApproval } from "../../domain/approvals"
import { createInvoiceDraft } from "../../domain/commands/invoices"
import { executeCommand } from "../../domain/execute"
import { issueDocument, reserveDocument, prepareDocument, executeIssuanceCommand } from "../issuance"
import { appRouter } from "../../trpc/router"
import { issuedInvoiceSnapshot } from "../../domain/documents/issued-invoice"
import { composeQuoteEmail } from "../../domain/documents/quote-email"
import { serializePublicQuoteSession } from "../../lib/quotes/public-session"
import { nonVatStatement } from "../../lib/documents/non-vat-note"
import { composeInvoiceEmail } from "../../domain/documents/invoice-email"
import { serializePublicInvoiceSession } from "../../lib/payments/public-session"
import { loadDocumentView } from "../../domain/documents/view"
import { setRuntimeExtensions } from "../../lib/runtime/extensions"
import { creditNotePdfParties } from "../../lib/credit-notes/pdf-parties"
import { selfhostDocumentRenderer } from "../../selfhost/runtime"
import { validateEinvoice } from "../../lib/exports/ubl"
import { getDocumentRenderer, getDocumentArtifactStore } from "../../lib/runtime/services"
import type { RenderInput } from "../../domain/documents/render-input"

const cleanups: Array<() => Promise<void>> = []
beforeEach(() => { vi.stubEnv("RESEND_API_KEY", ""); vi.stubEnv("EMAIL_PROVIDER", ""); vi.stubEnv("SMTP_HOST", "") })
afterEach(async () => { setRuntimeExtensions([]); vi.unstubAllEnvs(); while (cleanups.length) await cleanups.pop()?.() })
async function completed<T extends { status: string }>(promise: Promise<T>): Promise<T> {
  const result = await promise
  if (result.status !== "completed") throw new Error(JSON.stringify(result))
  return result
}
async function setup(momsRegistered: boolean | null, taxRate = 25) {
  const org = await createTestOrganization({ settings: { momsRegistered, countryCode: "DK", currency: "DKK", taxRegime: "eu_vat", locale: "da-DK" } })
  cleanups.push(org.cleanup)
  await prisma.organizationTaxId.create({ data: { organizationId: org.organizationId, scheme: "cvr", value: "12345678", countryCode: "DK" } })
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Synthetic buyer", email: "buyer@example.test", country: "DK" } })
  const draft = await executeCommand(createInvoiceDraft, { contactId: contact.id, dueDate: "2026-11-09", supplyDate: "2026-10-11", taxRate, items: [{ ...(momsRegistered === false && taxRate === 0 ? { vat: { treatment: "unclassified_zero" as const, rate: "0" } } : {}), description: "Synthetic service", quantity: 1, unitPrice: 100 }] }, { actor: org.actors.admin })
  if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
  const caller = appRouter.createCaller({ session: { user: { id: org.actors.admin.userId, email: "admin@example.test", name: "Synthetic admin" }, session: { activeOrganizationId: org.organizationId } } } as never)
  return { org, invoice: draft.result, caller, args: { kind: "invoice" as const, actor: org.actors.admin, commandInput: { id: draft.result.id, supplyDate: "2026-10-11", allowSendWithoutEmail: true } } }
}

;(hasTestDatabase ? describe : describe.skip)("seller VAT status at invoice issuance", () => {
  it("blocks an unset status before numbering or preparation", async () => {
    const ctx = await setup(null)
    expect(await issueDocument(ctx.args)).toMatchObject({ status: "failed", error: { code: "seller_vat_status_unset" } })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: ctx.invoice.id } })).toMatchObject({ status: "draft", number: null })
    expect(await prisma.artifactStaging.count({ where: { documentId: ctx.invoice.id } })).toBe(0)
    expect(await prisma.job.count({ where: { organizationId: ctx.org.organizationId } })).toBe(0)
    expect((await ctx.caller.settings.get()).invoiceNextNum).toBe(1)
    await ctx.caller.settings.update({ momsRegistered: true })
    await completed(issueDocument(ctx.args))
  })
  it("re-checks an open draft after settings change, without changing its amounts", async () => {
    const ctx = await setup(true)
    await ctx.caller.settings.update({ momsRegistered: false })
    const unchanged = await prisma.invoice.findUniqueOrThrow({ where: { id: ctx.invoice.id }, include: { items: true } })
    expect(unchanged.totalGross.toString()).toBe("125")
    expect(unchanged.items[0]!.taxRate.toString()).toBe("25")
    expect((await ctx.caller.invoices.get({ id: ctx.invoice.id })).momsRegistered).toBe(false)
    expect((await loadDocumentView(ctx.org.actors.admin, "invoice", ctx.invoice.id))?.view.seller.momsRegistered).toBe(false)
    expect(await issueDocument(ctx.args)).toMatchObject({ status: "failed", error: { code: "seller_not_vat_registered" } })
    expect((await ctx.caller.settings.get()).taxRate).toBe(0)
  })
  it("checks the current registration choice when sending an existing quote draft", async () => {
    const ctx = await setup(null)
    const input = { contactId: ctx.invoice.contactId, expiryDate: "2026-11-09", taxRate: 25, items: [{ description: "Synthetic service", quantity: 1, unitPrice: 100 }] }
    const quote = await ctx.caller.quotes.create(input)
    await ctx.caller.settings.update({ momsRegistered: true })
    await ctx.caller.quotes.send({ id: quote.id, allowSendWithoutEmail: true })
    expect(parseSellerSnapshot((await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } })).sellerSnapshot)?.momsRegistered).toBe(true)
    const second = await ctx.caller.quotes.create(input)
    await ctx.caller.settings.update({ momsRegistered: false })
    await expect(ctx.caller.quotes.send({ id: second.id, allowSendWithoutEmail: true })).rejects.toThrow("not VAT-registered")
    expect(await prisma.quote.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ status: "draft", number: null })
  })
  it.each([sendAgreement, issueAgreement])("guards existing agreement drafts at $type before issuance", async command => {
    const ctx = await setup(true)
    const draft = await completed(executeCommand(createAgreementDraft, {
      contactId: ctx.invoice.contactId, title: "Synthetic agreement", validUntil: "2099-12-01", taxRate: 25,
      deliverables: [{ title: "Synthetic service", description: "Service", quantity: 1, unitPrice: 100 }],
    }, { actor: ctx.org.actors.admin }))
    if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
    await ctx.caller.settings.update({ momsRegistered: false })
    const render = vi.spyOn(getDocumentRenderer()!, "renderPdf")
    const store = vi.spyOn(getDocumentArtifactStore()!, "put")
    expect(await executeIssuanceCommand(command, { id: draft.result.id }, { actor: ctx.org.actors.admin })).toMatchObject({ status: "failed", error: { code: "seller_not_vat_registered" } })
    expect(render).not.toHaveBeenCalled()
    expect(store).not.toHaveBeenCalled()
    render.mockRestore()
    store.mockRestore()
    expect(await prisma.artifactStaging.count({ where: { documentId: draft.result.id } })).toBe(0)
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })).agreementNextNum).toBe(1)
    const unchanged = await prisma.agreement.findUniqueOrThrow({ where: { id: draft.result.id }, include: { deliverables: true } })
    expect(unchanged).toMatchObject({ status: "draft", number: null, offerSnapshotHash: null, publicAccessIssuedAt: null })
    expect(unchanged.deliverables[0]!.taxRate.toNumber()).toBe(25)
    expect(unchanged.totalGross.toNumber()).toBe(125)
    expect(await prisma.job.count({ where: { organizationId: ctx.org.organizationId } })).toBe(0)
    // The same stored draft still issues with custom tax, despite the remembered VAT choice.
    await prisma.agreement.update({ where: { id: draft.result.id }, data: { taxRegime: "custom" } })
    await completed(executeIssuanceCommand(issueAgreement, { id: draft.result.id }, { actor: ctx.org.actors.admin }))
  })
  it.each([null, true] as const)("guards agreement registration %s against unclassified-zero lines", async momsRegistered => {
    const ctx = await setup(false, 0)
    const draft = await completed(executeCommand(createAgreementDraft, {
      contactId: ctx.invoice.contactId, title: "Synthetic zero agreement", validUntil: "2099-12-01", taxRate: 0,
      deliverables: [{ title: "Synthetic service", description: "Service", quantity: 1, unitPrice: 100, vat: { treatment: "unclassified_zero", rate: "0" } }],
    }, { actor: ctx.org.actors.admin }))
    if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
    await prisma.orgSettings.update({ where: { organizationId: ctx.org.organizationId }, data: { momsRegistered } })
    expect(await executeIssuanceCommand(issueAgreement, { id: draft.result.id }, { actor: ctx.org.actors.admin })).toMatchObject({ status: "failed", error: { code: momsRegistered === null ? "seller_vat_status_unset" : "evidence_incomplete" } })
    await ctx.caller.settings.update({ momsRegistered: false })
    await completed(executeIssuanceCommand(issueAgreement, { id: draft.result.id }, { actor: ctx.org.actors.admin }))
  })
  it.each(["DE", "FR", "NL"])("keeps %s EU self-hosted issuance available without the Danish registration choice", async countryCode => {
    const ctx = await setup(null)
    await prisma.orgSettings.update({ where: { organizationId: ctx.org.organizationId }, data: { countryCode } })
    const input = { contactId: ctx.invoice.contactId, taxRate: 25, items: [{ description: "Synthetic EU service", quantity: 1, unitPrice: 100 }] }
    const invoice = await completed(executeCommand(createInvoiceDraft, { ...input, dueDate: "2099-12-01" }, { actor: ctx.org.actors.admin }))
    if (invoice.status !== "completed") throw new Error(JSON.stringify(invoice))
    await completed(issueDocument({ kind: "invoice", actor: ctx.org.actors.admin, commandInput: { id: invoice.result.id, allowSendWithoutEmail: true } }))
    const quote = await ctx.caller.quotes.create({ ...input, expiryDate: "2099-12-01" })
    await ctx.caller.quotes.send({ id: quote.id, allowSendWithoutEmail: true })
    const agreement = await completed(executeCommand(createAgreementDraft, { contactId: ctx.invoice.contactId, title: "Synthetic EU agreement", validUntil: "2099-12-01", taxRate: 25,
      deliverables: [{ title: "Synthetic service", description: "Service", quantity: 1, unitPrice: 100 }],
    }, { actor: ctx.org.actors.admin }))
    if (agreement.status !== "completed") throw new Error(JSON.stringify(agreement))
    await completed(executeIssuanceCommand(issueAgreement, { id: agreement.result.id }, { actor: ctx.org.actors.admin }))
    expect(await prisma.agreement.findUniqueOrThrow({ where: { id: agreement.result.id } })).toMatchObject({ status: "sent" })
  })
  it("keeps custom taxed invoice and inherited credit UBL valid despite remembered non-registration", async () => {
    const ctx = await setup(false, 0)
    await prisma.orgSettings.update({ where: { organizationId: ctx.org.organizationId }, data: { taxRegime: "custom", companyName: "Synthetic custom seller", companyAddress: "Testvej 1, 1000 København" } })
    await prisma.organizationTaxId.updateMany({ where: { organizationId: ctx.org.organizationId }, data: { value: "24256790" } })
    await prisma.contact.update({ where: { id: ctx.invoice.contactId }, data: { address: "Testvej 2", city: "København", zip: "1000", peppolEndpointId: "24256790", peppolEndpointScheme: "0184" } })
    const draft = await completed(executeCommand(createInvoiceDraft, { contactId: ctx.invoice.contactId, taxRate: 25, notes: `Synthetic custom instructions\n${nonVatStatement("da-DK")}`, dueDate: "2099-12-01", items: [{ description: "Synthetic custom tax", quantity: 1, unitPrice: 100 }] }, { actor: ctx.org.actors.admin }))
    if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
    await completed(issueDocument({ kind: "invoice", actor: ctx.org.actors.admin, commandInput: { id: draft.result.id, allowSendWithoutEmail: true } }))
    const check = async (kind: "invoice" | "creditNote", documentId: string) => {
      const candidate = await prisma.issuanceCandidate.findFirstOrThrow({ where: { documentId } })
      const render = candidate.renderInput as unknown as Extract<RenderInput, { kind: typeof kind }>
      if (!render.ubl) throw new Error("Custom tax UBL input missing")
      expect(render.ubl.seller.vatId).toBe("DK24256790")
      expect(render.ubl.seller.momsRegistered).toBeUndefined()
      expect(render.ubl.note ?? "").not.toContain(nonVatStatement("da-DK"))
      expect(validateEinvoice(render.ubl)).toEqual([])
      const bytes = await selfhostDocumentRenderer.renderUbl!(render)
      expect(bytes).not.toBeNull()
      expect(new TextDecoder().decode(bytes!)).toContain("DK24256790")
    }
    await check("invoice", draft.result.id)
    await completed(issueDocument({ kind: "creditNote", actor: ctx.org.actors.admin, commandInput: { invoiceId: draft.result.id, mode: "full", reason: "Synthetic custom correction" } }))
    await check("creditNote", (await prisma.creditNote.findFirstOrThrow({ where: { invoiceId: draft.result.id } })).id)
  })
  it.each([true, false])("invalidates a quote send approval after registration %s changes", async registered => {
    const ctx = await setup(registered, 0)
    const draft = await completed(executeCommand(createQuoteDraft, {
      contactId: ctx.invoice.contactId, expiryDate: "2099-12-01", taxRate: 0,
      items: [{ description: "Synthetic service", quantity: 1, unitPrice: 100 }],
    }, { actor: ctx.org.actors.admin }))
    if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
    const { secret } = await createAgentKey(ctx.org.actors.admin, { name: "Synthetic sender", mode: "approval_required", scopes: ["quote:send"] })
    const actor = await authenticateAgentSecret(secret)
    const queued = await executeCommand(sendQuote, { id: draft.result.id, allowSendWithoutEmail: true }, { actor })
    expect(queued.status).toBe("awaiting_approval")
    if (queued.status !== "awaiting_approval") throw new Error(JSON.stringify(queued))
    await ctx.caller.settings.update({ momsRegistered: !registered })
    const approval = await decideApproval({ approvalRequestId: queued.approvalRequestId, decider: ctx.org.actors.admin, decision: "approve" })
    expect(approval).toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
    expect(await prisma.quote.findUniqueOrThrow({ where: { id: draft.result.id } })).toMatchObject({ status: "draft", number: null, publicAccessIssuedAt: null })
    expect(await prisma.job.count({ where: { organizationId: ctx.org.organizationId } })).toBe(0)
  })
  it.each(["us_sales_tax", "custom"] as const)("issues taxed invoices and quotes under %s despite non-VAT registration", async taxRegime => {
    const ctx = await setup(false, 0)
    await prisma.orgSettings.update({ where: { organizationId: ctx.org.organizationId }, data: { taxRegime, taxRate: 7 } })
    const input = { contactId: ctx.invoice.contactId, taxRate: 7, items: [{ description: "Synthetic taxed service", quantity: 1, unitPrice: 100 }] }
    const invoice = await completed(executeCommand(createInvoiceDraft, { ...input, dueDate: "2026-11-09", supplyDate: "2026-10-11" }, { actor: ctx.org.actors.admin }))
    if (invoice.status !== "completed") throw new Error(JSON.stringify(invoice))
    await completed(issueDocument({ kind: "invoice", actor: ctx.org.actors.admin, commandInput: { id: invoice.result.id, allowSendWithoutEmail: true } }))
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.result.id } })).toMatchObject({ status: "sent", taxRegime })
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.result.id } })).totalTax.toNumber()).toBe(7)
    const quote = await ctx.caller.quotes.create({ ...input, expiryDate: "2026-11-09" })
    await ctx.caller.quotes.send({ id: quote.id, allowSendWithoutEmail: true })
    const sent = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } })
    expect(sent.status).toBe("sent")
    expect(sent.totalTax.toNumber()).toBe(7)
  })
  it.each(["da-DK", "en-US"])("keeps frozen non-VAT quote status and rates in public and email data in %s", async locale => {
    const ctx = await setup(false, 0)
    await prisma.orgSettings.update({ where: { organizationId: ctx.org.organizationId }, data: { locale, companyName: "Frozen synthetic seller" } })
    const quote = await ctx.caller.quotes.create({ contactId: ctx.invoice.contactId, expiryDate: "2026-11-09", taxRate: 0,
      notes: `Synthetic instructions\n${nonVatStatement(locale)}`, items: [{ description: "Synthetic service", quantity: 1, unitPrice: 100, vat: { treatment: "unclassified_zero", rate: "0" } }] })
    await ctx.caller.quotes.send({ id: quote.id, allowSendWithoutEmail: true })
    await ctx.caller.settings.update({ momsRegistered: true, companyName: "Changed synthetic seller" })
    const sent = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id }, include: { items: true, contact: true, invoices: true } })
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })
    const publicQuote = serializePublicQuoteSession({ quote: sent, decisionState: "pending" }, "synthetic").quote
    expect(publicQuote.sellerSnapshot?.momsRegistered).toBe(false)
    expect(publicQuote.items[0]?.taxRate).toBe(0)
    expect(publicQuote.totalGross).toBe(100)
    const html = composeQuoteEmail({ quote: { ...sent, number: sent.number! }, settings, to: "buyer@example.test", publicQuoteUrl: "https://example.test/q/synthetic" }).message.html
    expect(html.split(nonVatStatement(locale))).toHaveLength(2)
    expect(html).toContain(locale === "da-DK" ? "Ingen moms" : "No moms")
    expect(html).toContain("Synthetic instructions")
    expect(html).toContain("Frozen synthetic seller")
    expect(html).not.toContain("Changed synthetic seller")
  })
  it.each([true, false])("freezes registration %s on issue across later status changes", async registered => {
    const ctx = await setup(registered, registered ? 25 : 0)
    await completed(issueDocument(ctx.args))
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: ctx.invoice.id }, include: { items: true, contact: true } })
    const candidate = await prisma.issuanceCandidate.findFirstOrThrow({ where: { documentId: ctx.invoice.id } })
    const render = candidate.renderInput as unknown as Extract<RenderInput, { kind: "invoice" }>
    expect(parseSellerSnapshot(before.sellerSnapshot)?.momsRegistered).toBe(registered)
    expect(issuedInvoiceSnapshot(before.issuanceSnapshot)?.seller.momsRegistered).toBe(registered)
    expect(render.pdf.invoice.momsRegistered).toBe(registered)
    if (!registered) expect(render.ubl).toBeUndefined()
    await ctx.caller.settings.update({ momsRegistered: !registered })
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: ctx.invoice.id }, include: { items: true, contact: true } })
    expect(after.sellerSnapshot).toEqual(before.sellerSnapshot)
    expect(after.issuanceSnapshot).toEqual(before.issuanceSnapshot)
    expect(after.artifactPdfHash).toBe(before.artifactPdfHash)
    expect((await ctx.caller.invoices.get({ id: ctx.invoice.id })).momsRegistered).toBe(registered)
    expect((await loadDocumentView(ctx.org.actors.admin, "invoice", ctx.invoice.id))?.view.seller.momsRegistered).toBe(registered)
    expect(serializePublicInvoiceSession({ invoice: after, stripeEnabled: false, paymentState: "unpaid" }, "synthetic").invoice.sellerSnapshot?.momsRegistered).toBe(registered)
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })
    const email = composeInvoiceEmail({ invoice: { ...after, number: after.number! }, settings, to: "buyer@example.test", publicPaymentUrl: null }).message.html
    expect(email.includes("Virksomheden er ikke momsregistreret.")).toBe(!registered)
    expect((await prisma.issuanceCandidate.findUniqueOrThrow({ where: { id: candidate.id } })).renderInput).toEqual(candidate.renderInput)
    const note = await completed(issueDocument({ kind: "creditNote", actor: ctx.org.actors.admin, commandInput: { invoiceId: ctx.invoice.id, mode: "full", reason: "Synthetic correction" } }))
    expect(note.status).toBe("completed")
    const credit = await prisma.creditNote.findFirstOrThrow({ where: { invoiceId: ctx.invoice.id } })
    expect(parseSellerSnapshot(credit.sellerSnapshot)?.momsRegistered).toBe(registered)
    expect((credit.issuanceSnapshot as { seller: { momsRegistered: boolean } }).seller.momsRegistered).toBe(registered)
  })
  it.each([
    ["us_sales_tax", undefined, 7], ["custom", undefined, 7], ["eu_vat", undefined, 0],
    ["eu_vat", "us_sales_tax", 7], ["eu_vat", "custom", 7], ["custom", "eu_vat", 0],
  ] as const)("uses effective tax regime %s -> %s when saving non-registration", async (storedRegime, taxRegime, expectedRate) => {
    const ctx = await setup(true)
    await prisma.orgSettings.update({ where: { organizationId: ctx.org.organizationId }, data: { taxRegime: storedRegime, taxRate: 7 } })
    await ctx.caller.settings.update({ momsRegistered: false, ...(taxRegime ? { taxRegime } : {}) })
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })).taxRate?.toNumber()).toBe(expectedRate)
    // A subsequent partial update keeps a non-VAT tax default and still normalizes EU VAT only.
    await ctx.caller.settings.update({ taxRate: 8 })
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })).taxRate?.toNumber()).toBe(expectedRate === 0 ? 0 : 8)
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: ctx.invoice.id } })).totalGross.toString()).toBe("125")
  })
  it.each([["DE", "eu_vat", 19], ["US", "custom", 7.5]] as const)("recovers taxed issuance after leaving Denmark for %s without rewriting the old invoice", async (countryCode, taxRegime, taxRate) => {
    const ctx = await setup(false, 0)
    await completed(issueDocument(ctx.args))
    const frozen = await prisma.invoice.findUniqueOrThrow({ where: { id: ctx.invoice.id } })
    // This is the normalized payload submitted by the country-change handler.
    const saved = await ctx.caller.settings.update({ countryCode, taxRegime, momsRegistered: null, taxRate })
    expect(saved.momsRegistered).toBeNull()
    expect(saved.taxRate?.toNumber()).toBe(taxRate)
    const draft = await completed(executeCommand(createInvoiceDraft, {
      contactId: ctx.invoice.contactId, dueDate: "2026-11-09", supplyDate: "2026-10-11", taxRate,
      items: [{ description: "Synthetic new-jurisdiction service", quantity: 1, unitPrice: 100 }],
    }, { actor: ctx.org.actors.admin }))
    if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
    await completed(issueDocument({ ...ctx.args, commandInput: { ...ctx.args.commandInput, id: draft.result.id } }))
    const issued = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.result.id }, include: { items: true } })
    expect(issued.status).toBe("sent")
    expect(issued.items[0]!.taxRate.toNumber()).toBe(taxRate)
    expect(issued.totalTax.toNumber()).toBe(taxRate)
    expect(issued.totalGross.toNumber()).toBe(100 + taxRate)
    expect(parseSellerSnapshot(issued.sellerSnapshot)?.momsRegistered).toBeNull()
    const historic = await prisma.invoice.findUniqueOrThrow({ where: { id: ctx.invoice.id } })
    expect(historic.sellerSnapshot).toEqual(frozen.sellerSnapshot)
    expect(historic.issuanceSnapshot).toEqual(frozen.issuanceSnapshot)
    expect(historic.totalGross.toString()).toBe("100")
    expect(historic.totalTax.toString()).toBe("0")
    expect(parseSellerSnapshot(historic.sellerSnapshot)?.momsRegistered).toBe(false)
  })
  it("refuses an unchanged draft if VAT status changes after artifact preparation", async () => {
    const ctx = await setup(true)
    const staging = await reserveDocument({ ...ctx.args, clientRequestId: "vat-status-race" })
    await prepareDocument(staging.id)
    await ctx.caller.settings.update({ momsRegistered: false })
    expect(await issueDocument({ ...ctx.args, clientRequestId: "vat-status-race" })).toMatchObject({ status: "failed", error: { code: "seller_not_vat_registered" } })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: ctx.invoice.id } })).toMatchObject({ status: "draft", number: null })
    expect(await prisma.issuanceCandidate.count({ where: { documentId: ctx.invoice.id } })).toBe(0)
  })
  it("passes the explicit three-state choice to runtime policy hooks", async () => {
    const ctx = await setup(false, 0)
    const seen: Array<boolean | null | undefined> = []
    setRuntimeExtensions([{ id: "synthetic-vat-policy", resolveInvoiceIssuancePolicy: ({ seller }) => { seen.push(seller.momsRegistered); return { standardVatRate: "25", requireSellerVatStatus: true } } }])
    await completed(issueDocument(ctx.args))
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.every(value => value === false)).toBe(true)
  })
  it("keeps legacy credit notes unconfirmed when the source invoice has no VAT snapshot", async () => {
    const ctx = await setup(true)
    await completed(issueDocument(ctx.args))
    await prisma.invoice.update({ where: { id: ctx.invoice.id }, data: { sellerSnapshot: { companyName: "Historic seller" }, issuanceSnapshot: Prisma.DbNull } })
    const result = await completed(issueDocument({ kind: "creditNote", actor: ctx.org.actors.admin, commandInput: { invoiceId: ctx.invoice.id, mode: "full", reason: "Synthetic historical correction" } }))
    expect(result.status).toBe("completed")
    expect(parseSellerSnapshot((await prisma.creditNote.findFirstOrThrow({ where: { invoiceId: ctx.invoice.id } })).sellerSnapshot)?.momsRegistered).toBeUndefined()
  })
  it.each([true, false])("preserves null-snapshot seller identity without borrowing current VAT status %s", async registered => {
    // MOCK: synthetic organization and historical invoice, never customer records.
    const ctx = await setup(true)
    await completed(issueDocument(ctx.args))
    await ctx.caller.settings.update({ momsRegistered: registered })
    await prisma.orgSettings.update({ where: { organizationId: ctx.org.organizationId }, data: {
      companyName: "Synthetic legacy seller", companyEmail: "legacy@example.test",
      companyAddress: "Testvej 1, 1000 København", bankRegNumber: "0040", bankAccountNumber: "0440116243",
    } })
    await prisma.invoice.update({ where: { id: ctx.invoice.id }, data: { sellerSnapshot: Prisma.DbNull, issuanceSnapshot: Prisma.DbNull } })
    await completed(issueDocument({ kind: "creditNote", actor: ctx.org.actors.admin, commandInput: {
      invoiceId: ctx.invoice.id, mode: "full", reason: "Synthetic historical correction",
    } }))
    const credit = await prisma.creditNote.findFirstOrThrow({ where: { invoiceId: ctx.invoice.id } })
    const candidate = await prisma.issuanceCandidate.findFirstOrThrow({ where: { documentId: credit.id } })
    const render = candidate.renderInput as unknown as Extract<RenderInput, { kind: "creditNote" }>
    const identity = {
      companyName: "Synthetic legacy seller", companyEmail: "legacy@example.test",
      companyAddress: "Testvej 1, 1000 København",
      taxIds: [{ scheme: "cvr", value: "12345678", countryCode: "DK" }],
    }
    expect(credit.sellerSnapshot).toMatchObject(identity)
    expect(render.pdf.creditNote.sellerSnapshot).toEqual(credit.sellerSnapshot)
    expect((credit.issuanceSnapshot as { seller: unknown }).seller).toEqual(credit.sellerSnapshot)
    for (const snapshot of [credit.sellerSnapshot, render.pdf.creditNote.sellerSnapshot]) {
      expect(parseSellerSnapshot(snapshot)?.momsRegistered).toBeUndefined()
      expect(snapshot).not.toHaveProperty("bankAccount")
      expect(snapshot).not.toHaveProperty("paymentNote")
    }
    const parties = creditNotePdfParties(render.pdf.creditNote, render.pdf.org)
    expect(parties.seller).toMatchObject({ name: identity.companyName, email: identity.companyEmail, address: identity.companyAddress })
    expect(parties.seller.taxIds.join(" ")).toContain("12345678")
    await ctx.caller.settings.update({ momsRegistered: !registered, companyName: "Changed synthetic seller" })
    expect((await prisma.creditNote.findUniqueOrThrow({ where: { id: credit.id } })).sellerSnapshot).toEqual(credit.sellerSnapshot)
  })

})
