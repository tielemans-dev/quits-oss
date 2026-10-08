import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createInvoiceDraft, sendInvoice } from "../../domain/commands/invoices"
import { recordPayment } from "../../domain/commands/payments"
import { recordBaseValuation } from "../../domain/commands/base-valuation"
import { executeCommand } from "../../domain/execute"
import { issueDocument, reserveDocument, prepareDocument } from "../issuance"
import { bindIssuanceCandidate } from "../../domain/documents/artifacts"
import type { RenderInput } from "../../domain/documents/render-input"
import { appRouter } from "../../trpc/router"
import { resolveBaseCurrency } from "../../domain/documents/base-currency"
import { invoiceIssuedSchema, creditNoteIssuedSchema } from "../../domain/events/money"

const cleanups: Array<() => Promise<void>> = []
beforeEach(() => { vi.stubEnv("RESEND_API_KEY", "") })
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); vi.unstubAllEnvs() })
async function setup(input: { currency?: string; net?: string; taxRate?: string; inclusive?: boolean } = {}) {
  const org = await createTestOrganization({ settings: { pricesIncludeTax: input.inclusive ?? false } })
  cleanups.push(org.cleanup)
  await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { baseCurrency: "DKK" } })
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Buyer", email: "buyer@example.test", taxIds: { create: { scheme: "VAT", value: "DE123456789" } } } })
  const draft = await executeCommand(createInvoiceDraft, { contactId: contact.id, dueDate: "2099-01-01", currency: input.currency ?? "EUR", supplyDate: "2099-01-01", taxRate: input.taxRate ?? "25", items: [{ description: "Work", quantity: "1", unitPrice: input.net ?? "0.04" }] }, { actor: org.actors.admin })
  if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
  return { org, invoice: draft.result, actor: org.actors.admin, contact }
}
async function issue(context: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown> = {}) {
  return issueDocument({ kind: "invoice", actor: context.actor, commandInput: { id: context.invoice.id, allowSendWithoutEmail: true, exchangeRate: "0.8", rateDate: "2026-10-07", ...extra } })
}
async function issued(id: string) {
  const event = await prisma.domainEvent.findFirstOrThrow({ where: { aggregateId: id, type: "invoice.issued" } })
  expect(event.schemaVersion).toBe(1)
  return invoiceIssuedSchema.parse(event.payload)
}
;(hasTestDatabase ? describe : describe.skip)("A3b frozen money issuance", () => {
  it("requires a user-confirmed foreign rate and refuses direct command bypass", async () => {
    const context = await setup()
    expect(await issueDocument({ kind: "invoice", actor: context.actor, commandInput: { id: context.invoice.id, allowSendWithoutEmail: true } })).toMatchObject({ status: "failed", error: { code: "base_valuation_required" } })
    expect(await executeCommand(sendInvoice, { id: context.invoice.id }, { actor: context.actor })).toMatchObject({ status: "failed", error: { code: "issuance_required" } })
    expect(await prisma.domainEvent.count({ where: { aggregateId: context.invoice.id, type: "invoice.issued" } })).toBe(0)
  })
  it("freezes refreshed buyer tax ids, dates, base components and one event across retries", async () => {
    const context = await setup()
    await prisma.contactTaxId.updateMany({ where: { contactId: context.contact.id }, data: { value: "DE987654321" } })
    const request = { kind: "invoice" as const, actor: context.actor, clientRequestId: "one-issuance", commandInput: { id: context.invoice.id, allowSendWithoutEmail: true, exchangeRate: "0.8", rateDate: "2026-10-07", vatReporting: { rate: "0.9", rateSource: "user", taxBaseForReturn: "0.04", taxForReturn: "0.01" } } }
    expect(await issueDocument(request)).toMatchObject({ status: "completed" })
    expect(await issueDocument(request)).toMatchObject({ status: "completed" })
    const event = await issued(context.invoice.id)
    expect(event.valuation).toMatchObject({ base: { minor: "4", currency: "DKK" }, rate: "0.8", rateSource: "user" })
    expect(event.vatGroups[0]).toMatchObject({ grossBase: "0.04", taxBase: "0.01", netBase: "0.03" })
    expect(event.buyer.taxIds?.[0].value).toBe("DE987654321")
    expect(event.taxPointReason).toBe("invoice_issued")
    expect(event.postingDate).toBe(event.issueDate)
    expect(event.vatReporting?.rate).toBe("0.9")
    expect(await prisma.domainEvent.count({ where: { aggregateId: context.invoice.id, type: "invoice.issued" } })).toBe(1)
    await expect(prisma.$transaction(tx => resolveBaseCurrency(tx, context.org.organizationId, { baseCurrency: "USD" }))).rejects.toMatchObject({ code: "base_currency_locked" })
    expect(await prisma.$transaction(tx => resolveBaseCurrency(tx, context.org.organizationId, { baseCurrency: "DKK" }))).toBe("DKK")
  })
  it("uses rate one for same currency and records earlier supply as tax-point review", async () => {
    const context = await setup({ currency: "DKK" })
    expect(await issue(context, { exchangeRate: "1", supplyDate: "2020-01-01" })).toMatchObject({ status: "completed" })
    expect(await issued(context.invoice.id)).toMatchObject({ valuation: { rateSource: "same_currency", rate: "1" }, taxPointReason: "tax_point_review", taxPointDate: null })
  })
  it("five partial credits exhaust frozen base components and retain the negative third base net", async () => {
    const context = await setup()
    expect(await issue(context)).toMatchObject({ status: "completed" })
    const reversals: Array<{ net: string; tax: string; gross: string }> = []
    for (let index = 0; index < 5; index++) {
      const result = await issueDocument({ kind: "creditNote", actor: context.actor, clientRequestId: `credit-${index}`, commandInput: { invoiceId: context.invoice.id, mode: "amount", amount: "0.01", reason: "Partial correction" } })
      expect(result, JSON.stringify(result)).toMatchObject({ status: "completed" })
      if (result.status !== "completed") throw new Error("credit failed")
      const event = await prisma.domainEvent.findFirstOrThrow({ where: { aggregateId: result.result.id, type: "credit_note.issued" } })
      expect(event.schemaVersion).toBe(2)
      const payload = creditNoteIssuedSchema.parse(event.payload)
      if (!("historicalReversal" in payload)) throw new Error("Sparse event")
      const stored = await prisma.creditNoteItem.findMany({ where: { creditNoteId: result.result.id }, orderBy: { sortOrder: "asc" } })
      expect(payload.lines.map(line => line.lineId)).toEqual(stored.map(line => line.id))
      expect(payload.postable).toBe(true)
      expect(payload.allocationsReleased).toEqual([])
      expect(payload.fxDifferenceBase).toBe("0.00")
      reversals.push({ net: payload.historicalReversal[0].revenueBase!, tax: payload.historicalReversal[0].taxBase!, gross: payload.debtorDischarge.carryingBase! })
    }
    expect(reversals[2].net).toBe("-0.01")
    expect(reversals.reduce((sum, r) => sum.plus(r.net), new (await import("../../../generated/prisma/client")).Prisma.Decimal(0)).toFixed(2)).toBe("0.03")
    expect(await issueDocument({ kind: "creditNote", actor: context.actor, commandInput: { invoiceId: context.invoice.id, mode: "amount", amount: "0.01", reason: "Excess" } })).toMatchObject({ status: "failed" })
  })
  it("keeps a credit against a non-voided payment incomplete even when open balance permits it", async () => {
    const context = await setup({ net: "100" })
    expect(await issue(context)).toMatchObject({ status: "completed" })
    expect(await executeCommand(recordPayment, { invoiceId: context.invoice.id, amount: 10, method: "bank_transfer", paidAt: "2026-10-07" }, { actor: context.actor })).toMatchObject({ status: "completed" })
    const result = await issueDocument({ kind: "creditNote", actor: context.actor, commandInput: { invoiceId: context.invoice.id, mode: "amount", amount: "5", reason: "Paid correction" } })
    expect(result).toMatchObject({ status: "completed" })
    if (result.status !== "completed") throw new Error("credit failed")
    const event = await prisma.domainEvent.findFirstOrThrow({ where: { aggregateId: result.result.id, type: "credit_note.issued" } })
    expect(event.payload).toMatchObject({ postable: false, incompleteReason: "allocations_pending", allocationsReleased: null, debtorDischarge: { carryingBase: null } })
  })
  it("records a reviewed historical rate without mutating the old money event or supply date", async () => {
    const context = await setup()
    await prisma.invoice.update({ where: { id: context.invoice.id }, data: { status: "sent", number: "INV-0001", supplyDate: null } })
    expect(await executeCommand(recordBaseValuation, { id: context.invoice.id, exchangeRate: "7.45", rateDate: "2026-10-07", evidenceNote: "Historical invoice and rate reviewed" }, { actor: context.actor })).toMatchObject({ status: "completed" })
    const doc = await prisma.invoice.findUniqueOrThrow({ where: { id: context.invoice.id } })
    expect(doc.supplyDate).toBeNull()
    expect(doc.valuation).toMatchObject({ rateSource: "user", rate: "7.45" })
    expect(doc.issuanceSnapshot).toMatchObject({ taxPointReason: "tax_point_review" })
    expect(await executeCommand(recordBaseValuation, { id: context.invoice.id, exchangeRate: "8", rateDate: "2026-10-07", evidenceNote: "Changed" }, { actor: context.actor })).toMatchObject({ status: "failed", error: { code: "valuation_already_recorded" } })
    expect(await prisma.domainEvent.count({ where: { aggregateId: context.invoice.id, type: "invoice.issued" } })).toBe(0)
    expect(await prisma.domainEvent.count({ where: { aggregateId: context.invoice.id, type: "invoice.base_valuation_recorded" } })).toBe(1)
  })
  it("refuses a reviewed rate when historical lines cannot account for the stored totals", async () => {
    const context = await setup()
    await prisma.invoice.update({ where: { id: context.invoice.id }, data: { status: "sent", totalGross: "5" } })
    expect(await executeCommand(recordBaseValuation, { id: context.invoice.id, exchangeRate: "7.45", rateDate: "2026-10-07", evidenceNote: "Review" }, { actor: context.actor })).toMatchObject({ status: "failed", error: { code: "historical_groups_unavailable" } })
    expect(await prisma.domainEvent.count({ where: { aggregateId: context.invoice.id, type: "invoice.base_valuation_recorded" } })).toBe(0)
  })
  it("keeps the base currency locked while a candidate waits and after issued history is recalled", async () => {
    const context = await setup()
    const staging = await reserveDocument({ kind: "invoice", actor: context.actor, clientRequestId: "pending-base", commandInput: { id: context.invoice.id, exchangeRate: "7.45", rateDate: "2026-10-07" } })
    const prepared = await prepareDocument(staging.id)
    await prisma.$transaction(tx => bindIssuanceCandidate(tx, { staging: prepared, renderInput: prepared.renderInput as unknown as RenderInput, organizationId: context.org.organizationId, requestKey: prepared.requestKey, now: new Date() }))
    await expect(prisma.$transaction(tx => resolveBaseCurrency(tx, context.org.organizationId, { baseCurrency: "USD" }))).rejects.toMatchObject({ code: "base_currency_locked" })
    await prisma.issuanceCandidate.updateMany({ where: { documentId: context.invoice.id }, data: { status: "retired" } })
    expect(await issue(context)).toMatchObject({ status: "completed" })
    await prisma.invoice.update({ where: { id: context.invoice.id }, data: { status: "draft" } })
    await expect(prisma.$transaction(tx => resolveBaseCurrency(tx, context.org.organizationId, { baseCurrency: "USD" }))).rejects.toMatchObject({ code: "base_currency_locked" })
  })
  it("keeps dashboard currencies separate and excludes unknown invoice or credit valuations", async () => {
    const context = await setup({ net: "100" })
    expect(await issue(context)).toMatchObject({ status: "completed" })
    const other = await executeCommand(createInvoiceDraft, { contactId: context.contact.id, currency: "DKK", dueDate: "2099-01-01", supplyDate: "2099-01-01", taxRate: "0", items: [{ description: "Domestic", quantity: "1", unitPrice: "50" }] }, { actor: context.actor })
    if (other.status !== "completed") throw new Error(JSON.stringify(other))
    expect(await issueDocument({ kind: "invoice", actor: context.actor, commandInput: { id: other.result.id, allowSendWithoutEmail: true } })).toMatchObject({ status: "completed" })
    expect(await executeCommand(recordPayment, { invoiceId: context.invoice.id, amount: 10, method: "bank_transfer", paidAt: "2026-10-07" }, { actor: context.actor })).toMatchObject({ status: "completed" })
    const caller = appRouter.createCaller({ session: { user: { id: context.actor.userId, email: "dashboard@example.test", name: "Dashboard" }, session: { activeOrganizationId: context.org.organizationId } } } as never)
    expect(await caller.dashboard.stats()).toMatchObject({ currencyBuckets: [{ currency: "DKK", totalRevenue: "0", outstanding: "50" }, { currency: "EUR", totalRevenue: "10", outstanding: "115" }], totalRevenue: null, outstanding: null, baseTotal: { currency: "DKK", amount: "150.00", excludedUnknownValuations: 0 } })
    const credit = await issueDocument({ kind: "creditNote", actor: context.actor, commandInput: { invoiceId: context.invoice.id, mode: "amount", amount: "5", reason: "Credit" } })
    if (credit.status !== "completed") throw new Error(JSON.stringify(credit))
    expect(await caller.dashboard.stats()).toMatchObject({ baseTotal: { amount: "146.00", excludedUnknownValuations: 0 } })
    await prisma.creditNote.update({ where: { id: credit.result.id }, data: { valuation: { rateSource: "unknown", base: { minor: null, currency: "DKK", exponent: 2 } } } })
    expect(await caller.dashboard.stats()).toMatchObject({ baseTotal: { amount: "50.00", excludedUnknownValuations: 1 } })
    await prisma.invoice.update({ where: { id: other.result.id }, data: { valuation: { rateSource: "unknown", base: { minor: null, currency: "DKK", exponent: 2 } } } })
    expect(await caller.dashboard.stats()).toMatchObject({ baseTotal: { amount: "0.00", excludedUnknownValuations: 2 } })
  })
})
