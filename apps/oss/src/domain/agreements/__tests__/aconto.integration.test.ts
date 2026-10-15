import { afterEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { executeIssuanceCommand as execute } from "../../../application/issuance"
import { createAgreementDraft } from "../../commands/agreements"
import { issueAgreement, recordAgreementAcceptance } from "../../commands/agreement-lifecycle"
import { markDeliverableDelivered, acceptDeliverable } from "../../commands/deliverables"
import { createInvoiceFromDeliverables, invoiceScheduleAsSale } from "../../commands/invoices-from-deliverables"
import { deductInvoiceDeposits } from "../../commands/invoice-deposits"
import { sendInvoice, updateInvoiceDraft, deleteInvoiceDraft } from "../../commands/invoices"
import { issueCreditNote } from "../../commands/credit-notes"
import type { CommandOutcome } from "../../execute"
import { getDocumentArtifactStore } from "../../../lib/runtime/services"
import { postingsFor } from "../../accounting/postings"
import { Prisma } from "../../../../generated/prisma/client"
import { setRuntimeExtensions } from "../../../lib/runtime/extensions"
import { getAgentTool } from "../../agent-tools/registry"
import { releaseDeliverableReservation } from "../../commands/billing-allocation"
import { loadDocumentView } from "../../documents/view"
import { appRouter } from "../../../trpc/router"

vi.mock("../../../lib/email", async () => ({ ...await vi.importActual<typeof import("../../../lib/email")>("../../../lib/email"), deliver: vi.fn(async () => ({ id: "synthetic" })) }))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { setRuntimeExtensions([]); while (cleanups.length) await cleanups.pop()!(); vi.unstubAllEnvs() })
function completed<T>(outcome: CommandOutcome<T>): T {
  expect(outcome.status, JSON.stringify(outcome)).toBe("completed")
  if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
  return outcome.result
}
const read = (id: string) => prisma.invoice.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { sortOrder: "asc" } } } })
async function fixture(unitPrice = "100", taxRate = "25", pricesIncludeTax = false, secondDeposit = false) {
  vi.stubEnv("RESEND_API_KEY", "synthetic-aconto")
  vi.stubEnv("FROM_EMAIL", "billing@example.test")
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-aconto-secret-over-32-characters")
  const org = await createTestOrganization({ settings: { currency: "DKK", taxRate: Number(taxRate), pricesIncludeTax, countryCode: "DK", locale: "da-DK", taxRegime: "eu_vat" } }); cleanups.push(org.cleanup)
  await prisma.organizationTaxId.createMany({ data: [
    { organizationId: org.organizationId, scheme: "cvr", value: "12345674", countryCode: "DK", isPrimary: true },
    { organizationId: org.organizationId, scheme: "vat", value: "DK12345674", countryCode: "DK" },
  ] })
  const actor = org.actors.admin
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Customer", email: "customer@example.test" } })
  const agreement = completed(await execute(createAgreementDraft, { contactId: contact.id, title: "Project", validUntil: "2099-01-01", taxRate,
    deliverables: [{ title: "Aconto", quantity: "1", unitPrice: "20.03", isDeposit: true },
      { title: "Work", quantity: "1", unitPrice }, { title: "More work", quantity: "1", unitPrice },
      ...(secondDeposit ? [{ title: "Second aconto", quantity: "1", unitPrice: "20.03", isDeposit: true }] : [])],
  }, { actor }))
  completed(await execute(issueAgreement, { id: agreement.id }, { actor }))
  completed(await execute(recordAgreementAcceptance, { id: agreement.id, acceptedByName: "Customer", evidenceNote: "Written acceptance" }, { actor }))
  const create = async (index: number) => {
    const line = { agreementId: agreement.id, id: agreement.deliverables[index]!.id }
    if (index === 1 || index === 2) {
      completed(await execute(markDeliverableDelivered, line, { actor }))
      completed(await execute(acceptDeliverable, { ...line, evidenceNote: "Accepted" }, { actor }))
    }
    const ids = completed(await execute(createInvoiceFromDeliverables, { agreementId: agreement.id, deliverableIds: [line.id] }, { actor }))
    return (ids.saleInvoiceId ?? ids.prepaymentInvoiceId)!
  }
  const sourceId = await create(0)
  completed(await execute(invoiceScheduleAsSale, { id: sourceId, confirmed: true }, { actor }))
  completed(await execute(sendInvoice, { id: sourceId }, { actor }))
  return { actor, create, agreement, sourceId, source: await read(sourceId) }
}

;(hasTestDatabase ? describe : describe.skip)("aconto deductions", () => {
  it("deducts frozen øre and VAT, references the original, and freezes the same rendered totals", async () => {
    const ctx = await fixture(), id = await ctx.create(1)
    const draft = await read(id), deduction = draft.items.find(line => line.sourceKind === "aconto")!
    expect([draft.subtotalNet.toFixed(2), draft.totalTax.toFixed(2), draft.totalGross.toFixed(2)]).toEqual(["79.97", "19.99", "99.96"])
    expect(deduction.description).toContain(ctx.source.number)
    expect(deduction.sourceRevision).toBe(ctx.sourceId)
    const draftView = (await loadDocumentView(ctx.actor, "invoice", id))!.view
    expect(draftView.totals?.gross).toBe("99.96")
    expect(draftView.lines.find(line => line.quantity === "-1")?.locked).toBe(true)
    completed(await execute(sendInvoice, { id }, { actor: ctx.actor }))
    const issued = await read(id)
    expect((await loadDocumentView(ctx.actor, "invoice", id))!.view.totals?.gross).toBe("99.96")
    const rendered = JSON.parse(new TextDecoder().decode((await getDocumentArtifactStore()!.get(issued.artifactPdfRef!))!))
    expect(rendered.pdf.invoice.total).toBe(99.96)
    expect(rendered.pdf.invoice.items.some((line: { description: string }) => line.description.includes(ctx.source.number!))).toBe(true)
    expect(rendered.ubl.storedGross).toBe("99.96")
    const event = await prisma.domainEvent.findFirstOrThrow({ where: { aggregateId: id, type: "invoice.issued" } })
    expect(Array.isArray(postingsFor(event))).toBe(true)
    expect(await read(ctx.sourceId)).toEqual(ctx.source)
    expect(await execute(deductInvoiceDeposits, { id, amountGross: "0" }, { actor: ctx.actor })).toMatchObject({ status: "failed", error: { code: "not_draft" } })
    expect(await read(id)).toEqual(issued)
    expect((await read(await ctx.create(2))).items.some(line => line.sourceKind === "aconto")).toBe(false)
  })
  it("reserves once across concurrent drafts and releases on removal or draft deletion", async () => {
    const ctx = await fixture()
    const ids = await Promise.all([ctx.create(1), ctx.create(2)])
    const drafts = await Promise.all(ids.map(read))
    expect(drafts.flatMap(doc => doc.items.filter(line => line.sourceKind === "aconto"))).toHaveLength(1)
    const winner = drafts.find(doc => doc.items.some(line => line.sourceKind === "aconto"))!, other = ids.find(id => id !== winner.id)!
    completed(await execute(deductInvoiceDeposits, { id: winner.id, amountGross: "0" }, { actor: ctx.actor }))
    completed(await execute(deductInvoiceDeposits, { id: other }, { actor: ctx.actor }))
    completed(await execute(deleteInvoiceDraft, { id: other }, { actor: ctx.actor }))
    completed(await execute(deductInvoiceDeposits, { id: winner.id }, { actor: ctx.actor }))
    expect((await read(winner.id)).totalGross.toFixed(2)).toBe("99.96")
  })
  it("carries cumulative VAT rounding through partial deductions without reusing øre", async () => {
    const ctx = await fixture(), first = await ctx.create(1)
    const caller = appRouter.createCaller({ session: { user: { id: ctx.actor.userId, email: "admin@example.test", name: "Admin" }, session: { activeOrganizationId: ctx.actor.organizationId } } } as never)
    expect((await caller.invoices.deductDeposits({ id: first, amountGross: "0.03" })).total).toBe(124.97)
    expect((await read(first)).totalTax.toFixed(2)).toBe("24.99")
    completed(await execute(sendInvoice, { id: first }, { actor: ctx.actor }))
    const second = await ctx.create(2), remaining = await read(second)
    expect(remaining.totalGross.toFixed(2)).toBe("99.99")
    expect(remaining.totalTax.toFixed(2)).toBe("20.00")
    completed(await execute(sendInvoice, { id: second }, { actor: ctx.actor }))
    const deductions = await prisma.invoiceItem.findMany({ where: { sourceKind: "aconto", sourceRevision: ctx.sourceId } })
    expect(deductions.reduce((sum, line) => sum.minus(line.lineGross), new Prisma.Decimal(0)).toFixed(2)).toBe("25.04")
    expect(deductions.reduce((sum, line) => sum.minus(line.lineTax), new Prisma.Decimal(0)).toFixed(2)).toBe("5.01")
    expect(await read(ctx.sourceId)).toEqual(ctx.source)
  })
  it("preserves deductions on draft edits and refuses crediting an allocated source", async () => {
    const ctx = await fixture(), id = await ctx.create(1), draft = await read(id)
    const work = draft.items.find(line => line.deliverableId)!
    completed(await execute(updateInvoiceDraft, { id, notes: "Changed", items: [{ id: work.id, deliverableId: work.deliverableId!, description: work.description, quantity: work.quantityInput!, unitPrice: work.unitPriceInput! }] }, { actor: ctx.actor }))
    expect((await read(id)).totalGross.toFixed(2)).toBe("99.96")
    expect(await execute(issueCreditNote, { invoiceId: ctx.sourceId, mode: "full", reason: "Correction" }, { actor: ctx.actor })).toMatchObject({ status: "failed", error: { code: "aconto_allocated" } })
    expect(await execute(deductInvoiceDeposits, { id, amountGross: "25.05" }, { actor: ctx.actor })).toMatchObject({ status: "failed", error: { code: "aconto_insufficient" } })
    expect(await read(ctx.sourceId)).toEqual(ctx.source)
  })
  it("restores the exact residual VAT when an earlier partial draft is removed", async () => {
    const ctx = await fixture(), first = await ctx.create(1)
    completed(await execute(deductInvoiceDeposits, { id: first, amountGross: "0.03" }, { actor: ctx.actor }))
    const second = await ctx.create(2), retained = await read(second)
    completed(await execute(deductInvoiceDeposits, { id: first, amountGross: "0" }, { actor: ctx.actor }))
    completed(await execute(sendInvoice, { id: second }, { actor: ctx.actor }))
    completed(await execute(deductInvoiceDeposits, { id: first }, { actor: ctx.actor }))
    expect((await read(first)).items.find(line => line.sourceKind === "aconto")!.lineTax.toFixed(2)).toBe("-0.01")
    expect((await read(second)).items).toEqual(retained.items)
  })
  it("enforces revisions, tenancy and capability states, and keeps ordinary invoicing available", async () => {
    const ctx = await fixture(), id = await ctx.create(1)
    expect(await execute(deductInvoiceDeposits, { id, expectedRevision: 999 }, { actor: ctx.actor })).toMatchObject({ status: "failed", error: { code: "stale_draft" } })
    const other = await createTestOrganization(); cleanups.push(other.cleanup)
    expect(await execute(deductInvoiceDeposits, { id }, { actor: other.actors.admin })).toMatchObject({ status: "failed", error: { tag: "NotFound" } })
    setRuntimeExtensions([{ id: "disabled", resolveCapabilities: () => ({ agreements: { depositsEnabled: false } }) }])
    expect(await execute(sendInvoice, { id }, { actor: ctx.actor })).toMatchObject({ status: "failed", error: { code: "deposits_disabled" } })
    completed(await execute(deductInvoiceDeposits, { id, amountGross: "0" }, { actor: ctx.actor }))
    expect(await execute(deductInvoiceDeposits, { id }, { actor: ctx.actor })).toMatchObject({ status: "failed", error: { code: "deposits_disabled" } })
    completed(await execute(sendInvoice, { id: await ctx.create(2) }, { actor: ctx.actor }))
    expect(getAgentTool({ kind: "agent", organizationId: ctx.actor.organizationId, agentKeyId: "synthetic", ownerRoles: ctx.actor.roles, label: "Test agent", scopes: ["invoice:update"], mode: "full_access" }, "invoice_deduct_deposits").commandType).toBe("invoice.deduct_deposits")
  })
  it("rejects removing work underneath a reserved deduction", async () => {
    const ctx = await fixture(), id = await ctx.create(1), doc = await read(id), work = doc.items.find(line => line.deliverableId)!
    expect(await execute(releaseDeliverableReservation, { agreementId: ctx.agreement.id, deliverableId: work.deliverableId!, expectedAllocation: { invoiceId: id, invoiceItemId: work.id, generation: 0 } }, { actor: ctx.actor })).toMatchObject({ status: "failed", error: { code: "aconto_exceeds_final" } })
    expect(await read(id)).toEqual(doc)
  })
  it.each(["20.03", "0.02"])("caps deductions at the final amount and issues a fully covered invoice for %s net", async unitPrice => {
    const ctx = await fixture(unitPrice), id = await ctx.create(1), doc = await read(id)
    expect([doc.subtotalNet.toFixed(2), doc.totalTax.toFixed(2), doc.totalGross.toFixed(2)]).toEqual(["0.00", "0.00", "0.00"])
    completed(await execute(sendInvoice, { id }, { actor: ctx.actor }))
    expect(await read(ctx.sourceId)).toEqual(ctx.source)
  })
  it("deducts a frozen zero-VAT source without introducing VAT", async () => {
    const ctx = await fixture("100", "0"), id = await ctx.create(1), doc = await read(id)
    expect([doc.subtotalNet.toFixed(2), doc.totalTax.toFixed(2), doc.totalGross.toFixed(2)]).toEqual(["79.97", "0.00", "79.97"])
    completed(await execute(sendInvoice, { id }, { actor: ctx.actor }))
  })
  it("keeps tax-inclusive source components exact", async () => {
    const ctx = await fixture("100", "25", true), id = await ctx.create(1), doc = await read(id)
    expect([doc.subtotalNet.toFixed(2), doc.totalTax.toFixed(2), doc.totalGross.toFixed(2)]).toEqual(["63.98", "15.99", "79.97"])
    completed(await execute(sendInvoice, { id }, { actor: ctx.actor }))
    expect(await read(ctx.sourceId)).toEqual(ctx.source)
  })
  it("references and deducts multiple earlier aconto invoices", async () => {
    const ctx = await fixture("100", "25", false, true), second = await ctx.create(3)
    completed(await execute(invoiceScheduleAsSale, { id: second, confirmed: true }, { actor: ctx.actor }))
    completed(await execute(sendInvoice, { id: second }, { actor: ctx.actor }))
    const id = await ctx.create(1), doc = await read(id)
    expect(doc.totalGross.toFixed(2)).toBe("74.92")
    expect(doc.items.filter(line => line.sourceKind === "aconto").map(line => line.sourceRevision).sort()).toEqual([ctx.sourceId, second].sort())
    completed(await execute(sendInvoice, { id }, { actor: ctx.actor }))
  })
})
