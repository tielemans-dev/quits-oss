// MOCK: synthetic test organizations, parties, document amounts and rates only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "../../../generated/prisma/client"
import { parseSellerSnapshot } from "@quits/contracts/documents"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createInvoiceDraft } from "../../domain/commands/invoices"
import { executeCommand } from "../../domain/execute"
import { issueDocument, reserveDocument, prepareDocument } from "../issuance"
import { appRouter } from "../../trpc/router"
import { issuedInvoiceSnapshot } from "../../domain/documents/issued-invoice"
import { composeInvoiceEmail } from "../../domain/documents/invoice-email"
import { serializePublicInvoiceSession } from "../../lib/payments/public-session"
import { loadDocumentView } from "../../domain/documents/view"
import { setRuntimeExtensions } from "../../lib/runtime/extensions"
import { creditNotePdfParties } from "../../lib/credit-notes/pdf-parties"
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
