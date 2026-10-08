import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../../../lib/email", async () => ({ ...await vi.importActual<typeof import("../../../lib/email")>("../../../lib/email"), deliver: vi.fn() }))
import { prisma } from "../../../lib/db"
import { deliver } from "../../../lib/email"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { type CommandOutcome } from "../../execute"
import { executeIssuanceCommand, issueDocument } from "../../../application/issuance"
import { createAgreementDraft } from "../../commands/agreements"
import { issueAgreement, recordAgreementAcceptance } from "../../commands/agreement-lifecycle"
import { markDeliverableDelivered, acceptDeliverable } from "../../commands/deliverables"
import { createInvoiceFromDeliverables, addInvoiceDeliverables } from "../../commands/invoices-from-deliverables"
import { deleteInvoiceDraft, updateInvoiceDraft } from "../../commands/invoices"
import { issueCreditNote } from "../../commands/credit-notes"
import { authorizeDeliverableRebill, releaseDeliverableReservation } from "../../commands/billing-allocation"
import { describeAllocations } from "../allocations"
import { createAgentKey, authenticateAgentSecret } from "../../agent-keys"
import { billableSourceKindSchema, reservedBillableSourceKindSchema, supportedBillableSources } from "@quits/contracts/billing"

const cleanups: Array<() => Promise<void>> = []
function completed<T>(outcome: CommandOutcome<T>): T {
  expect(outcome.status, JSON.stringify(outcome)).toBe("completed")
  if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
  return outcome.result
}
const refused = (outcome: CommandOutcome<unknown>, code: string) => expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "failed", error: { code } })
beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "synthetic-allocation")
  vi.stubEnv("FROM_EMAIL", "billing@example.test")
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-allocation-secret-over-32-characters-long")
  vi.mocked(deliver).mockReset().mockResolvedValue({ id: "synthetic" })
})
afterEach(async () => { vi.restoreAllMocks(); while (cleanups.length) await cleanups.pop()?.(); vi.unstubAllEnvs() })

async function setup(lineCount = 2) {
  const org = await createTestOrganization({ roles: ["admin", "accountant"] }); cleanups.push(org.cleanup)
  const actor = org.actors.admin
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Customer", email: "customer@example.test" } })
  const agreement = completed(await executeIssuanceCommand(createAgreementDraft, {
    contactId: contact.id, title: "Project", validUntil: "2099-01-01", taxRate: "25", billingTrigger: "on_acceptance",
    deliverables: Array.from({ length: lineCount }, (_, index) => ({ title: `Work ${index + 1}`, description: "Service", quantity: "1", unitPrice: "100" })),
  }, { actor }))
  completed(await executeIssuanceCommand(issueAgreement, { id: agreement.id }, { actor }))
  completed(await executeIssuanceCommand(recordAgreementAcceptance, { id: agreement.id, acceptedByName: "Customer", evidenceNote: "Written approval" }, { actor }))
  const id = (index = 0) => agreement.deliverables[index]!.id
  for (let index = 0; index < lineCount; index++) {
    completed(await executeIssuanceCommand(markDeliverableDelivered, { agreementId: agreement.id, id: id(index) }, { actor }))
    completed(await executeIssuanceCommand(acceptDeliverable, { agreementId: agreement.id, id: id(index), evidenceNote: "Signed off" }, { actor }))
  }
  const reserve = (ids: string[], clientRequestId?: string) => executeIssuanceCommand(createInvoiceFromDeliverables, { agreementId: agreement.id, deliverableIds: ids }, { actor, ...(clientRequestId ? { clientRequestId } : {}) })
  const line = (index = 0) => prisma.deliverable.findUniqueOrThrow({ where: { id: id(index) } })
  const view = async (index = 0, visible = { invoices: true, creditNotes: true }) =>
    (await describeAllocations(prisma, org.organizationId, agreement.id, [await line(index)], visible)).get(id(index))!
  const issue = async (invoiceId: string) => completed(await issueDocument({ kind: "invoice", actor, commandInput: { id: invoiceId } }))
  return { org, actor, agreement, contact, id, reserve, line, view, issue }
}
type Ctx = Awaited<ReturnType<typeof setup>>

/** Every deliverable's billing status must be explained by exactly the invoice line the rules allow. */
async function expectConsistentAllocations(ctx: Ctx) {
  for (const row of await prisma.deliverable.findMany({ where: { agreementId: ctx.agreement.id } })) {
    const items = await prisma.invoiceItem.findMany({ where: { deliverableId: row.id }, include: { invoice: true } })
    const current = items.filter(item => item.allocationGeneration === row.billingGeneration)
    expect(current.length, `${row.title} has at most one active allocation`).toBeLessThanOrEqual(1)
    if (row.billingStatus === "unbilled") expect(current, `${row.title} unbilled`).toHaveLength(0)
    if (row.billingStatus === "reserved") { expect(current, `${row.title} reserved`).toHaveLength(1); expect(current[0]!.invoice.status).toBe("draft") }
    if (row.billingStatus === "invoiced") { expect(current, `${row.title} invoiced`).toHaveLength(1); expect(current[0]!.invoice.status).not.toBe("draft") }
  }
}
const events = (ctx: Ctx, type: string) => prisma.domainEvent.count({ where: { organizationId: ctx.org.organizationId, type } })

;(hasTestDatabase ? describe : describe.skip)("billable allocation visibility and recovery", () => {
  it("explains an abandoned draft as the reason the work is unavailable, with the holder an authorized reader may open", async () => {
    const ctx = await setup()
    const { saleInvoiceId } = completed(await ctx.reserve([ctx.id(0)]))
    const draft = await prisma.invoice.findUniqueOrThrow({ where: { id: saleInvoiceId! } })
    expect(await ctx.view()).toMatchObject({ state: "reserved", holder: { invoiceId: draft.id, status: "draft" } })
    // A reader without invoice access still sees that the work is held, but not the document.
    expect(await ctx.view(0, { invoices: false, creditNotes: false })).toMatchObject({ state: "reserved", holder: null })
    const conflict = await ctx.reserve([ctx.id(0), ctx.id(1)])
    refused(conflict, "deliverable_reserved")
    expect(conflict).toMatchObject({ error: { details: { deliverableId: ctx.id(0), holdingInvoiceId: draft.id, holdingInvoiceStatus: "draft" } } })
    if (conflict.status === "failed") expect(conflict.error.message).toContain("Work 1")
    // Nothing was reserved by the refused attempt, so the other line is still free.
    expect((await ctx.line(1)).billingStatus).toBe("unbilled")
    await expectConsistentAllocations(ctx)
  })

  it("releases a reservation exactly once, recomputes the draft and lets another draft take the work", async () => {
    const ctx = await setup()
    const { saleInvoiceId } = completed(await ctx.reserve([ctx.id(0), ctx.id(1)]))
    const input = { agreementId: ctx.agreement.id, deliverableId: ctx.id(0) }
    const released = completed(await executeIssuanceCommand(releaseDeliverableReservation, input, { actor: ctx.actor }))
    expect(released).toMatchObject({ invoiceId: saleInvoiceId, remainingLines: 1 })
    const draft = await prisma.invoice.findUniqueOrThrow({ where: { id: saleInvoiceId! }, include: { items: true } })
    expect(draft.items.map(item => item.deliverableId)).toEqual([ctx.id(1)])
    expect(draft.totalGross.toString()).toBe("125")
    expect(await events(ctx, "deliverable.released")).toBe(1)
    refused(await executeIssuanceCommand(releaseDeliverableReservation, input, { actor: ctx.actor }), "not_reserved")
    expect(await events(ctx, "deliverable.released")).toBe(1)
    completed(await ctx.reserve([ctx.id(0)]))
    expect((await ctx.line(0)).billingStatus).toBe("reserved")
    await expectConsistentAllocations(ctx)
  })

  it("refuses to release work that is already on an issued invoice", async () => {
    const ctx = await setup(1)
    const { saleInvoiceId } = completed(await ctx.reserve([ctx.id(0)]))
    await ctx.issue(saleInvoiceId!)
    refused(await executeIssuanceCommand(releaseDeliverableReservation, { agreementId: ctx.agreement.id, deliverableId: ctx.id(0) }, { actor: ctx.actor }), "not_reserved")
    expect((await ctx.line()).billingStatus).toBe("invoiced")
    expect(await events(ctx, "deliverable.released")).toBe(0)
  })

  it("releases through line removal and draft deletion exactly once each", async () => {
    const ctx = await setup()
    const { saleInvoiceId } = completed(await ctx.reserve([ctx.id(0), ctx.id(1)]))
    const draft = await prisma.invoice.findUniqueOrThrow({ where: { id: saleInvoiceId! }, include: { items: { orderBy: { sortOrder: "asc" } } } })
    const keep = draft.items[1]!
    completed(await executeIssuanceCommand(updateInvoiceDraft, { id: draft.id, items: [{ id: keep.id, deliverableId: keep.deliverableId!, description: keep.description, quantity: keep.quantityInput!, unitPrice: keep.unitPriceInput! }] }, { actor: ctx.actor }))
    expect((await ctx.line(0)).billingStatus).toBe("unbilled")
    expect((await ctx.line(1)).billingStatus).toBe("reserved")
    expect(await events(ctx, "deliverable.released")).toBe(1)
    completed(await executeIssuanceCommand(deleteInvoiceDraft, { id: draft.id }, { actor: ctx.actor }))
    expect((await ctx.line(1)).billingStatus).toBe("unbilled")
    expect(await events(ctx, "deliverable.released")).toBe(2)
    expect(await prisma.invoiceItem.count({ where: { deliverableId: { in: [ctx.id(0), ctx.id(1)] } } })).toBe(0)
    await expectConsistentAllocations(ctx)
  })

  it("leaves no orphan reservation after a failed creation and can be retried", async () => {
    const ctx = await setup()
    const { billingProvider } = await import("../../../lib/billing")
    vi.spyOn(billingProvider, "assertInvoiceCreationAllowed").mockRejectedValueOnce(new Error("temporarily unavailable"))
    refused(await ctx.reserve([ctx.id(0)]), "precondition_failed")
    expect(await prisma.invoice.count({ where: { agreementId: ctx.agreement.id } })).toBe(0)
    expect((await ctx.line()).billingStatus).toBe("unbilled")
    expect(await events(ctx, "deliverable.reserved")).toBe(0)
    completed(await ctx.reserve([ctx.id(0)]))
    await expectConsistentAllocations(ctx)
  })
})

;(hasTestDatabase ? describe : describe.skip)("racing allocations in real transactions", () => {
  it("lets exactly one of a draft creation and an add-to-draft take the same work", async () => {
    const ctx = await setup()
    const { saleInvoiceId: other } = completed(await ctx.reserve([ctx.id(1)]))
    const [create, add] = await Promise.all([
      ctx.reserve([ctx.id(0)], "race-create"),
      executeIssuanceCommand(addInvoiceDeliverables, { id: other!, agreementId: ctx.agreement.id, deliverableIds: [ctx.id(0)] }, { actor: ctx.actor }),
    ])
    expect([create, add].filter(result => result.status === "completed")).toHaveLength(1)
    const loser = [create, add].find(result => result.status !== "completed")!
    refused(loser, "deliverable_reserved")
    expect(loser).toMatchObject({ error: { details: { deliverableId: ctx.id(0), holdingInvoiceStatus: "draft" } } })
    expect(await prisma.invoiceItem.count({ where: { deliverableId: ctx.id(0) } })).toBe(1)
    expect(await events(ctx, "deliverable.reserved")).toBe(2)
    await expectConsistentAllocations(ctx)
  })

  it("releases once when two releases race and keeps the work free for one new draft", async () => {
    const ctx = await setup(1)
    completed(await ctx.reserve([ctx.id(0)]))
    const input = { agreementId: ctx.agreement.id, deliverableId: ctx.id(0) }
    const results = await Promise.all([1, 2].map(() => executeIssuanceCommand(releaseDeliverableReservation, input, { actor: ctx.actor })))
    expect(results.filter(result => result.status === "completed")).toHaveLength(1)
    refused(results.find(result => result.status !== "completed")!, "not_reserved")
    expect(await events(ctx, "deliverable.released")).toBe(1)
    const rebooked = await Promise.all([ctx.reserve([ctx.id(0)], "again-a"), ctx.reserve([ctx.id(0)], "again-b")])
    expect(rebooked.filter(result => result.status === "completed")).toHaveLength(1)
    await expectConsistentAllocations(ctx)
  })

  it("keeps the database to one active allocation per source even if application checks are bypassed", async () => {
    const ctx = await setup(1)
    const { saleInvoiceId } = completed(await ctx.reserve([ctx.id(0)]))
    const existing = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: saleInvoiceId! } })
    expect(existing).toMatchObject({ sourceKind: "deliverable", sourceId: ctx.id(0), allocationGeneration: 0, sourceRevision: expect.any(String) })
    const { id: _id, ...copy } = existing
    await expect(prisma.invoiceItem.create({ data: { ...copy, deliverableId: ctx.id(0) } })).rejects.toMatchObject({ code: "P2002" })
    // A generic source id is guarded the same way, so a future time or expense adapter inherits the guard.
    await expect(prisma.invoiceItem.create({ data: { ...copy, deliverableId: null, sourceKind: "deliverable", sourceId: ctx.id(0) } })).rejects.toMatchObject({ code: "P2002" })
    expect(await prisma.invoiceItem.count({ where: { sourceId: ctx.id(0) } })).toBe(1)
  })
})

;(hasTestDatabase ? describe : describe.skip)("credits, rebilling and frozen lines", () => {
  const creditLine = (ctx: Ctx, invoiceId: string, itemId: string, quantity: string) => executeIssuanceCommand(issueCreditNote, { invoiceId, mode: "lines", lines: [{ invoiceItemId: itemId, quantity }], reason: "Correction" }, { actor: ctx.actor })

  it("keeps work invoiced after a partial or untied credit and refuses rebilling it", async () => {
    const ctx = await setup(1)
    const { saleInvoiceId } = completed(await ctx.reserve([ctx.id(0)]))
    await ctx.issue(saleInvoiceId!)
    const item = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: saleInvoiceId! } })
    const partial = completed(await creditLine(ctx, saleInvoiceId!, item.id, "0.5"))
    expect(await ctx.view()).toMatchObject({ state: "partially_credited", creditedQuantity: "0.5", quantity: "1" })
    expect((await ctx.line()).billingStatus).toBe("invoiced")
    refused(await ctx.reserve([ctx.id(0)]), "deliverable_already_invoiced")
    const rebill = { agreementId: ctx.agreement.id, deliverableId: ctx.id(0), creditNoteId: partial.id, reason: "Customer received half" }
    refused(await executeIssuanceCommand(authorizeDeliverableRebill, rebill, { actor: ctx.actor }), "line_not_fully_credited")
    // An amount credit is tied to no line, so it neither credits this work nor makes it billable.
    const amount = completed(await executeIssuanceCommand(issueCreditNote, { invoiceId: saleInvoiceId!, mode: "amount", amount: 10, reason: "Goodwill" }, { actor: ctx.actor }))
    expect(await ctx.view()).toMatchObject({ state: "partially_credited", invoiceHasUntiedCredit: true })
    refused(await executeIssuanceCommand(authorizeDeliverableRebill, { ...rebill, creditNoteId: amount.id }, { actor: ctx.actor }), "credit_note_mismatch")
    expect((await ctx.line()).billingStatus).toBe("invoiced")
    expect((await ctx.line()).billingGeneration).toBe(0)
    expect(await prisma.deliverableRebill.count()).toBe(0)
    await expectConsistentAllocations(ctx)
  })

  it("rebills fully credited work only on a person's decision and links the new line to the prior invoice and credit", async () => {
    const ctx = await setup(1)
    const { saleInvoiceId: first } = completed(await ctx.reserve([ctx.id(0)]))
    await ctx.issue(first!)
    const firstItem = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: first! } })
    const credit = completed(await creditLine(ctx, first!, firstItem.id, "1"))
    expect(await ctx.view()).toMatchObject({ state: "credited", rebill: { eligible: true, blocker: null }, creditNotes: [{ id: credit.id }] })
    // The credit alone changed nothing.
    expect((await ctx.line()).billingStatus).toBe("invoiced")
    refused(await ctx.reserve([ctx.id(0)]), "deliverable_already_invoiced")
    const issuedBefore = await prisma.invoice.findUniqueOrThrow({ where: { id: first! }, include: { items: true } })
    const input = { agreementId: ctx.agreement.id, deliverableId: ctx.id(0), creditNoteId: credit.id, reason: "Redelivered after the correction" }
    const key = await createAgentKey(ctx.actor, { name: "Agent", mode: "approval_required", scopes: ["invoice:create"], expiresInDays: null })
    refused(await executeIssuanceCommand(authorizeDeliverableRebill, input, { actor: await authenticateAgentSecret(key.secret) }), "human_review_required")
    expect((await ctx.line()).billingGeneration).toBe(0)
    const decision = completed(await executeIssuanceCommand(authorizeDeliverableRebill, input, { actor: ctx.actor }))
    expect(decision).toMatchObject({ generation: 1, priorInvoiceId: first, creditNoteId: credit.id })
    refused(await executeIssuanceCommand(authorizeDeliverableRebill, input, { actor: ctx.actor }), "rebill_not_invoiced")
    expect(await ctx.view()).toMatchObject({ state: "unbilled", generation: 1, rebills: [{ generation: 1, priorInvoiceId: first, creditNoteId: credit.id, reason: input.reason, decidedBy: `user:${ctx.actor.userId}` }] })
    expect(await events(ctx, "deliverable.rebill_authorized")).toBe(1)

    const { saleInvoiceId: second } = completed(await ctx.reserve([ctx.id(0)]))
    expect(second).not.toBe(first)
    const secondItem = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: second! } })
    expect(secondItem).toMatchObject({ deliverableId: ctx.id(0), allocationGeneration: 1, sourceId: ctx.id(0) })
    await ctx.issue(second!)
    expect((await ctx.line()).billingStatus).toBe("invoiced")
    // Issued artifacts of the first invoice are untouched.
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: first! }, include: { items: true } })).toEqual(issuedBefore)
    expect(await prisma.invoiceItem.count({ where: { deliverableId: ctx.id(0) } })).toBe(2)
    expect(await ctx.view()).toMatchObject({ state: "invoiced", holder: { invoiceId: second } })
    await expectConsistentAllocations(ctx)
  })

  it("cannot rewrite a frozen invoice line by changing the source afterwards", async () => {
    const ctx = await setup(1)
    const { saleInvoiceId } = completed(await ctx.reserve([ctx.id(0)]))
    const before = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: saleInvoiceId! } })
    // Simulates an adapter or administrator changing the source row after allocation.
    await prisma.deliverable.update({ where: { id: ctx.id(0) }, data: { title: "Renamed", description: "Changed", unitPriceNet: 999, lineNet: 999, lineGross: 1249, deliveryRevision: 7 } })
    expect(await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: saleInvoiceId! } })).toEqual(before)
    await ctx.issue(saleInvoiceId!)
    const issued = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: saleInvoiceId! } })
    expect(issued).toMatchObject({ description: before.description, lineNet: before.lineNet, sourceRevision: before.sourceRevision })
  })
})

describe("billable source contract", () => {
  it("accepts only implemented source kinds and reserves the time and expense names", () => {
    expect(billableSourceKindSchema.options).toEqual(["deliverable"])
    expect(reservedBillableSourceKindSchema.options).toEqual(["time_entry", "expense"])
    expect(supportedBillableSources.notSupported).toEqual(["time_entry", "expense", "scheduled_billing"])
    expect(billableSourceKindSchema.safeParse("time_entry").success).toBe(false)
  })
})
