import { executeIssuanceCommand } from "../../../application/issuance"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../../../lib/email", async () => ({ ...await vi.importActual<typeof import("../../../lib/email")>("../../../lib/email"), deliver: vi.fn() }))
import { prisma } from "../../../lib/db"
import { deliver, EmailSendError } from "../../../lib/email"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { type CommandOutcome } from "../../execute"
import { issueDocument, runArtifactRead } from "../../../application/issuance"
import { prospectiveRenderInput } from "../../documents/render-input"
import { createAgreementDraft, updateDeliverable } from "../../commands/agreements"
import { issueAgreement, recordAgreementAcceptance, closeAgreement } from "../../commands/agreement-lifecycle"
import { markDeliverableDelivered, acceptDeliverable, cancelDeliverable } from "../../commands/deliverables"
import { createInvoiceFromDeliverables, addInvoiceDeliverables, invoiceScheduleAsSale } from "../../commands/invoices-from-deliverables"
import { updateInvoiceDraft, deleteInvoiceDraft, sendInvoice } from "../../commands/invoices"
import { issueCreditNote } from "../../commands/credit-notes"
import { settleAbandonedDeliveries } from "../../delivery/outbox"
import { findEmailDeliveryJobs } from "../../../test-utils/email-outbox"
import { createAgentKey, authenticateAgentSecret } from "../../agent-keys"
import { decideApproval } from "../../approvals"
import { getAgentTool } from "../../agent-tools/registry"
import { billingProvider } from "../../../lib/billing"
import { isBillable } from "../billing-rules"

const cleanups: Array<() => Promise<void>> = []
function completed<T>(outcome: CommandOutcome<T>): T {
  expect(outcome.status, JSON.stringify(outcome)).toBe("completed")
  if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
  return outcome.result
}
const refused = (outcome: CommandOutcome<unknown>, code: string) => expect(outcome).toMatchObject({ status: "failed", error: { code } })
beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "synthetic-agreements-phase2")
  vi.stubEnv("FROM_EMAIL", "billing@example.test")
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-agreements-phase2-secret-over-32-characters")
  vi.mocked(deliver).mockReset().mockResolvedValue({ id: "synthetic" })
})
afterEach(async () => { vi.restoreAllMocks(); while (cleanups.length) await cleanups.pop()?.(); vi.unstubAllEnvs() })
async function setup(trigger = "on_acceptance", deposit = false, taxRate = "25") {
  const org = await createTestOrganization(); cleanups.push(org.cleanup)
  const actor = org.actors.admin
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Customer", email: "customer@example.test" } })
  const agreement = completed(await executeIssuanceCommand(createAgreementDraft, {
    contactId: contact.id, title: "Project", validUntil: "2099-01-01", taxRate, billingTrigger: trigger,
    deliverables: [{ title: "Design", description: "Design service", quantity: "1", unitPrice: "100" },
      { title: "Build", description: "Build service", quantity: "1", unitPrice: "200" },
      ...(deposit ? [{ title: "Deposit", quantity: "1", unitPrice: "30", isDeposit: true }] : [])],
  }, { actor }))
  completed(await executeIssuanceCommand(issueAgreement, { id: agreement.id }, { actor }))
  completed(await executeIssuanceCommand(recordAgreementAcceptance, { id: agreement.id, acceptedByName: "Customer", evidenceNote: "Written approval" }, { actor }))
  const item = (index = 0) => ({ agreementId: agreement.id, id: agreement.deliverables[index]!.id })
  const ready = async (index = 0, accept = true) => {
    completed(await executeIssuanceCommand(markDeliverableDelivered, item(index), { actor }))
    if (accept) completed(await executeIssuanceCommand(acceptDeliverable, { ...item(index), evidenceNote: "Signed off" }, { actor }))
    return item(index)
  }
  const selection = (ids = [item().id], extras = {}) => ({ agreementId: agreement.id, deliverableIds: ids, ...extras })
  const reserve = async (ids = [item().id], extras = {}) => completed(await executeIssuanceCommand(createInvoiceFromDeliverables, selection(ids, extras), { actor, clientRequestId: `reserve-${ids.join("-")}` }))
  const line = (index = 0) => prisma.deliverable.findUniqueOrThrow({ where: { id: item(index).id } })
  return { org, actor, agreement, contact, item, ready, selection, reserve, line }
}
const invoice = (id: string) => prisma.invoice.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { sortOrder: "asc" } } } })
const editLine = (line: Awaited<ReturnType<typeof invoice>>["items"][number]) => ({ id: line.id, deliverableId: line.deliverableId ?? undefined, description: line.description, quantity: line.quantityInput!, unitPrice: line.unitPriceInput! })

;(hasTestDatabase ? describe : describe.skip)("invoicing from deliverables", () => {
  it("checks billability, duplicate ids, foreign ids and cancelled deposits", async () => {
    const ctx = await setup("on_acceptance", true)
    expect(isBillable({ ...ctx.agreement, status: "accepted" }, await ctx.line())).toBe(false)
    await ctx.ready(0, false)
    refused(await executeIssuanceCommand(createInvoiceFromDeliverables, ctx.selection(), { actor: ctx.actor }), "deliverable_not_billable")
    completed(await executeIssuanceCommand(acceptDeliverable, { ...ctx.item(), evidenceNote: "Accepted" }, { actor: ctx.actor }))
    refused(await executeIssuanceCommand(createInvoiceFromDeliverables, ctx.selection([ctx.item().id, ctx.item().id]), { actor: ctx.actor }), "duplicate_deliverables")
    refused(await executeIssuanceCommand(createInvoiceFromDeliverables, ctx.selection(["foreign"]), { actor: ctx.actor }), "deliverable_not_billable")
    completed(await executeIssuanceCommand(cancelDeliverable, ctx.item(2), { actor: ctx.actor }))
    refused(await executeIssuanceCommand(createInvoiceFromDeliverables, ctx.selection([ctx.item(2).id]), { actor: ctx.actor }), "deliverable_not_billable")
  })
  it("reserves once under concurrency with two client ids and replays one receipt", async () => {
    const ctx = await setup(); await ctx.ready()
    const results = await Promise.all(["client-a", "client-b"].map(clientRequestId => executeIssuanceCommand(createInvoiceFromDeliverables, ctx.selection(), { actor: ctx.actor, clientRequestId })))
    expect(results.filter(result => result.status === "completed")).toHaveLength(1)
    const loser = results.find(result => result.status !== "completed")!
    refused(loser, "deliverable_reserved")
    expect(loser).toMatchObject({ error: { details: { deliverableId: ctx.item().id, holdingInvoiceStatus: "draft" } } })
    expect(await prisma.invoice.count({ where: { agreementId: ctx.agreement.id } })).toBe(1)
    expect((await ctx.line()).billingStatus).toBe("reserved")
    const winner = results.findIndex(result => result.status === "completed")
    expect(await executeIssuanceCommand(createInvoiceFromDeliverables, ctx.selection(), { actor: ctx.actor, clientRequestId: winner ? "client-b" : "client-a" })).toEqual(results[winner])
  })
  it("creates two drafts with one receipt, refuses prepayment issuance and records explicit sale conversion", async () => {
    const ctx = await setup("on_delivery", true); await ctx.ready(0, false)
    const result = await ctx.reserve([ctx.item().id, ctx.item(2).id])
    expect(result).toEqual({ saleInvoiceId: expect.any(String), prepaymentInvoiceId: expect.any(String) })
    expect((await invoice(result.saleInvoiceId!)).totalGross.toString()).toBe("125")
    expect(await invoice(result.prepaymentInvoiceId!)).toMatchObject({ purpose: "prepayment" })
    expect(await prisma.commandReceipt.count({ where: { organizationId: ctx.org.organizationId, commandType: "invoice.create_from_deliverables", status: "completed" } })).toBe(1)
    refused(await issueDocument({ kind: "invoice", actor: ctx.actor, commandInput: { id: result.prepaymentInvoiceId! } }), "purpose_issuance_not_supported")
    expect((await ctx.line(2)).billingStatus).toBe("reserved")
    expect(await prisma.artifactStaging.count({ where: { documentId: result.prepaymentInvoiceId } })).toBe(0)
    completed(await executeIssuanceCommand(invoiceScheduleAsSale, { id: result.prepaymentInvoiceId!, confirmed: true }, { actor: ctx.actor }))
    expect(await invoice(result.prepaymentInvoiceId!)).toMatchObject({ purpose: "sale", scheduleSaleChoice: { deliverableIds: [ctx.item(2).id], actor: `user:${ctx.actor.userId}`, commandId: expect.any(String) } })
  })
  it("rolls back both drafts, reservations, events and numbering if the second creation fails", async () => {
    const ctx = await setup("on_delivery", true); await ctx.ready(0, false)
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })
    vi.spyOn(billingProvider, "assertInvoiceCreationAllowed").mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("second draft failed"))
    refused(await executeIssuanceCommand(createInvoiceFromDeliverables, ctx.selection([ctx.item().id, ctx.item(2).id]), { actor: ctx.actor }), "precondition_failed")
    expect(await prisma.invoice.count({ where: { agreementId: ctx.agreement.id } })).toBe(0)
    expect((await ctx.line()).billingStatus).toBe("unbilled"); expect((await ctx.line(2)).billingStatus).toBe("unbilled")
    expect(await prisma.domainEvent.count({ where: { organizationId: ctx.org.organizationId, type: "deliverable.reserved" } })).toBe(0)
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })).invoiceNextNum).toBe(settings.invoiceNextNum)
  })
  it("preserves contact and linked values, uses frozen VAT for expenses, releases omissions and deletions", async () => {
    const ctx = await setup(); await ctx.ready(); await ctx.ready(1)
    const result = await ctx.reserve([ctx.item().id, ctx.item(1).id])
    const id = result.saleInvoiceId!, original = await invoice(id)
    const other = await prisma.contact.create({ data: { organizationId: ctx.org.organizationId, name: "Other" } })
    for (const change of [{ contactId: other.id }, { currency: "EUR" }, { taxRate: "5" }]) refused(await executeIssuanceCommand(updateInvoiceDraft, { id, ...change }, { actor: ctx.actor }), "linked_invoice_context_immutable")
    refused(await executeIssuanceCommand(updateInvoiceDraft, { id, items: [{ ...editLine(original.items[0]!), unitPrice: "999" }] }, { actor: ctx.actor }), "linked_item_immutable")
    await prisma.orgSettings.update({ where: { organizationId: ctx.org.organizationId }, data: { pricesIncludeTax: true, countryCode: "DK" } })
    completed(await executeIssuanceCommand(updateInvoiceDraft, { id, notes: "Only notes" }, { actor: ctx.actor }))
    expect((await invoice(id)).items).toEqual(original.items)
    completed(await executeIssuanceCommand(updateInvoiceDraft, { id, vatEvidence: { statementText: "Frozen classification evidence" } }, { actor: ctx.actor }))
    expect((await invoice(id)).items).toEqual(original.items)
    expect((await invoice(id)).vatEvidence).toMatchObject({ statementText: "Frozen classification evidence" })
    await prisma.contact.update({ where: { id: ctx.contact.id }, data: { name: "Changed buyer" } })
    await prisma.orgSettings.update({ where: { organizationId: ctx.org.organizationId }, data: { companyName: "Changed seller", companyAddress: "Changed address" } })
    const render = await prisma.$transaction(tx => runArtifactRead(prospectiveRenderInput({ kind: "invoice", documentId: id, commandInput: { id }, number: original.number ?? "INV-0001", issuedAt: new Date() }), tx, ctx.actor, new Date()))
    if (render.kind !== "invoice") throw new Error("Wrong render kind")
    expect(render.pdf.invoice.contact.name).toBe("Customer")
    expect(render.pdf.org.companyName).toBe((ctx.agreement.sellerSnapshot as { companyName: string }).companyName)
    expect(render.pdf.org.companyAddress).toBe((ctx.agreement.sellerSnapshot as { companyAddress: string }).companyAddress)
    const updated = completed(await executeIssuanceCommand(updateInvoiceDraft, { id, items: [editLine(original.items[0]!), { description: "Expense", quantity: "1", unitPrice: "40", vat: { treatment: "standard", rate: "0.05" } }] }, { actor: ctx.actor }))
    expect(updated.items[0]!.id).toBe(original.items[0]!.id)
    expect(updated.totalGross.toString()).toBe("175"); expect(updated.items[1]!.lineTax.toString()).toBe("10")
    expect((await ctx.line(1)).billingStatus).toBe("unbilled")
    completed(await executeIssuanceCommand(deleteInvoiceDraft, { id }, { actor: ctx.actor }))
    expect((await ctx.line()).billingStatus).toBe("unbilled")
  })
  it("retains the accepted decimal VAT rate for unlinked expenses", async () => {
    const ctx = await setup("on_acceptance", false, "25.1234"); await ctx.ready()
    const { saleInvoiceId: id } = await ctx.reserve()
    const original = await invoice(id!)
    const updated = completed(await executeIssuanceCommand(updateInvoiceDraft, { id, items: [editLine(original.items[0]!), { description: "Expense", quantity: "1", unitPrice: "10000" }] }, { actor: ctx.actor }))
    expect(updated.items[1]!.lineTax.toString()).toBe("2512.34")
    expect(updated.totalGross.toString()).toBe("12637.46")
  })
  it("adds billable deliverables only to a matching agreement and purpose", async () => {
    const ctx = await setup("on_acceptance", true); await ctx.ready(); await ctx.ready(1)
    const { saleInvoiceId: id } = await ctx.reserve()
    refused(await executeIssuanceCommand(addInvoiceDeliverables, { id, ...ctx.selection([ctx.item(1).id]), agreementId: "different-agreement" }, { actor: ctx.actor }), "agreement_mismatch")
    completed(await executeIssuanceCommand(addInvoiceDeliverables, { id, ...ctx.selection([ctx.item(1).id]) }, { actor: ctx.actor }))
    expect((await invoice(id!)).items).toHaveLength(2)
    refused(await executeIssuanceCommand(addInvoiceDeliverables, { id, ...ctx.selection([ctx.item(2).id]) }, { actor: ctx.actor }), "purpose_mismatch")
    completed(await executeIssuanceCommand(addInvoiceDeliverables, { id, ...ctx.selection([ctx.item(2).id]), scheduleAsSale: true }, { actor: ctx.actor }))
    expect(await invoice(id!)).toMatchObject({ scheduleSaleChoice: { deliverableIds: [ctx.item(2).id] } })
  })
  it.each(["delivered", "unconfirmed", "no-email", "rejected"])("publishes candidate-bound billing through %s issuance", async mode => {
    const ctx = await setup("on_delivery"); await ctx.ready(0, false)
    const { saleInvoiceId: id } = await ctx.reserve()
    if (mode === "rejected") vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("validation_error", "Rejected"))
    if (mode === "unconfirmed") vi.mocked(deliver).mockRejectedValueOnce(new Error("Connection lost"))
    if (mode === "no-email") vi.stubEnv("RESEND_API_KEY", "")
    completed(await issueDocument({ kind: "invoice", actor: ctx.actor, commandInput: { id, allowSendWithoutEmail: mode === "no-email" } }))
    if (mode === "unconfirmed") {
      const jobs = await findEmailDeliveryJobs(ctx.org.organizationId)
      const job = jobs.find(job => (job.payload as { completion: { target: { documentId?: string } } }).completion.target.documentId === id)!
      await prisma.job.update({ where: { id: job.id }, data: { status: "failed", attempts: 5, claimToken: null } })
      expect(await settleAbandonedDeliveries({ organizationIds: [ctx.org.organizationId] })).toMatchObject({ settled: 1, failed: 0 })
    }
    expect((await ctx.line()).billingStatus).toBe(mode === "rejected" ? "reserved" : "invoiced")
    expect((await invoice(id!)).status).toBe(mode === "rejected" ? "draft" : "sent")
    expect(await prisma.domainEvent.count({ where: { organizationId: ctx.org.organizationId, type: "deliverable.invoiced" } })).toBe(mode === "rejected" ? 0 : 1)
  })
  it("refuses reserved reopen/cancel/close, lists drafts and completes a delivery-billed project with a deposit", async () => {
    const ctx = await setup("on_delivery", true); const work = await ctx.ready(0, false); await ctx.ready(1)
    const result = await ctx.reserve(ctx.agreement.deliverables.map(line => line.id), { scheduleAsSale: true })
    refused(await executeIssuanceCommand(updateDeliverable, { ...work, status: "in_progress" }, { actor: ctx.actor }), "not_unbilled")
    refused(await executeIssuanceCommand(cancelDeliverable, work, { actor: ctx.actor }), "not_unbilled")
    for (const disposition of ["completed", "cancelled"]) {
      const failed = await executeIssuanceCommand(closeAgreement, { id: ctx.agreement.id, disposition, reason: "Close" }, { actor: ctx.actor })
      refused(failed, "reserved_deliverables")
      if (failed.status === "failed") expect(failed.error.message).toContain(result.saleInvoiceId!)
    }
    completed(await issueDocument({ kind: "invoice", actor: ctx.actor, commandInput: { id: result.saleInvoiceId! } }))
    refused(await executeIssuanceCommand(closeAgreement, { id: ctx.agreement.id, disposition: "completed", reason: "Done" }, { actor: ctx.actor }), "open_deliverables")
    completed(await executeIssuanceCommand(acceptDeliverable, { ...work, evidenceNote: "Accepted after invoicing" }, { actor: ctx.actor }))
    expect(completed(await executeIssuanceCommand(closeAgreement, { id: ctx.agreement.id, disposition: "completed", reason: "Done" }, { actor: ctx.actor })).status).toBe("completed")
  })
  it("completes a service-only project and cancelRemaining cancels only unbilled, unaccepted work", async () => {
    const ctx = await setup("on_delivery"); await ctx.ready()
    const { saleInvoiceId } = await ctx.reserve()
    completed(await issueDocument({ kind: "invoice", actor: ctx.actor, commandInput: { id: saleInvoiceId } }))
    expect(completed(await executeIssuanceCommand(closeAgreement, { id: ctx.agreement.id, disposition: "completed", cancelRemaining: true, reason: "Unused work removed" }, { actor: ctx.actor })).status).toBe("completed")
    expect((await ctx.line(1)).status).toBe("cancelled")
  })
  it("credit notes leave billing alone; approved send races edits and close without deadlock", async () => {
    const ctx = await setup(); await ctx.ready(); await ctx.ready(1)
    const { saleInvoiceId: id } = await ctx.reserve([ctx.item().id, ctx.item(1).id])
    const original = await invoice(id!)
    const key = await createAgentKey(ctx.actor, { name: "Invoice agent", mode: "approval_required", scopes: ["invoice:send", "invoice:create", "invoice:update"] })
    const agent = await authenticateAgentSecret(key.secret)
    expect(getAgentTool(agent, "invoice_create_from_deliverables").commandType).toBe("invoice.create_from_deliverables")
    expect(getAgentTool(agent, "invoice_add_deliverables").commandType).toBe("invoice.add_deliverables")
    const approval = await executeIssuanceCommand(sendInvoice, { id }, { actor: agent, clientRequestId: "send-review" })
    expect(approval.status).toBe("awaiting_approval")
    if (approval.status !== "awaiting_approval") throw new Error("Approval missing")
    const outcomes = await Promise.all([
      decideApproval({ decider: ctx.actor, approvalRequestId: approval.approvalRequestId, decision: "approve" }),
      executeIssuanceCommand(updateInvoiceDraft, { id, items: [editLine(original.items[0]!), { description: "Expense", quantity: "1", unitPrice: "20" }] }, { actor: ctx.actor }),
      executeIssuanceCommand(closeAgreement, { id: ctx.agreement.id, disposition: "completed", reason: "Done" }, { actor: ctx.actor }),
    ])
    expect(outcomes).toHaveLength(3)
    expect(outcomes[2]).toMatchObject({ status: "failed" })
    if ((await invoice(id!)).status === "draft") completed(await issueDocument({ kind: "invoice", actor: ctx.actor, commandInput: { id } }))
    completed(await executeIssuanceCommand(issueCreditNote, { invoiceId: id, mode: "full", reason: "Financial correction" }, { actor: ctx.actor }))
    const moneyEvent = await prisma.domainEvent.findFirstOrThrow({ where: { aggregateId: id!, type: "invoice.issued" } })
    expect(moneyEvent.payload).toMatchObject({ purpose: "sale", valuation: { rateSource: "same_currency", rate: "1" }, provenance: { agreementId: ctx.agreement.id, commandId: expect.any(String) }, calculation: { version: "v2" }, lines: expect.arrayContaining([expect.objectContaining({ deliverableId: ctx.item().id })]) })
    const money = moneyEvent.payload as { issueDate: string; postingDate: string; supplyDate: string }
    expect(money.postingDate).toBe(money.issueDate)
    expect(money.supplyDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect((await ctx.line()).billingStatus).toBe("invoiced")
  })
})
