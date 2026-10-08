import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../../../lib/email", async () => ({ ...await vi.importActual<typeof import("../../../lib/email")>("../../../lib/email"), deliver: vi.fn() }))
import { getPrisma, prisma } from "../../../lib/db"
import { Prisma } from "../../../../generated/prisma/client"
import { defaultNodePlatform } from "../../../lib/runtime/node-platform"
import { resetRuntimePlatform, setRuntimePlatform } from "../../../lib/runtime/platform"
import { getDocumentRenderer, getDocumentArtifactStore } from "../../../lib/runtime/services"
import { documentPdf } from "../../../lib/documents/pdf-access"
import { appRouter } from "../../../trpc/router"
import { deliver } from "../../../lib/email"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { executeCommand, type CommandOutcome } from "../../execute"
import { actorCan } from "../../actor"
import { executeIssuanceCommand, issueDocument, reserveDocument, prepareDocument } from "../../../application/issuance"
import { createAgreementDraft } from "../../commands/agreements"
import { closeAgreement, issueAgreement, recordAgreementAcceptance } from "../../commands/agreement-lifecycle"
import { markDeliverableDelivered, acceptDeliverable } from "../../commands/deliverables"
import { createInvoiceFromDeliverables, addInvoiceDeliverables } from "../../commands/invoices-from-deliverables"
import { deleteInvoiceDraft, sendInvoice, updateInvoiceDraft } from "../../commands/invoices"
import { issueCreditNote } from "../../commands/credit-notes"
import { authorizeDeliverableRebill, releaseDeliverableReservation } from "../../commands/billing-allocation"
import { describeAllocations } from "../allocations"
import { runAgentTool } from "../../agent-tools/mcp"
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
afterEach(async () => { resetRuntimePlatform(); vi.restoreAllMocks(); while (cleanups.length) await cleanups.pop()?.(); vi.unstubAllEnvs() })

async function setup(lineCount = 2) {
  const org = await createTestOrganization({ roles: ["admin", "member", "accountant"] }); cleanups.push(org.cleanup)
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
    (await describeAllocations(prisma, org.organizationId, agreement.id, [await line(index)], visible, (await prisma.agreement.findUniqueOrThrow({ where: { id: agreement.id } })).status)).get(id(index))!
  const releaseInput = async (index = 0) => {
    const item = await prisma.invoiceItem.findFirstOrThrow({ where: { deliverableId: id(index), allocationGeneration: (await line(index)).billingGeneration } })
    return { agreementId: agreement.id, deliverableId: id(index), expectedAllocation: { invoiceId: item.invoiceId, invoiceItemId: item.id, generation: item.allocationGeneration } }
  }
  const issue = async (invoiceId: string) => completed(await issueDocument({ kind: "invoice", actor, commandInput: { id: invoiceId } }))
  return { org, actor, agreement, contact, id, reserve, line, view, issue, releaseInput }
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
    const input = await ctx.releaseInput()
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

  it("lets a member release the last reservation without deleting the draft or duplicating a financial line", async () => {
    const ctx = await setup(1)
    const actor = ctx.org.actors.member
    expect(actorCan(actor, "invoice:update")).toBe(true)
    expect(actorCan(actor, "invoice:delete")).toBe(false)
    const { saleInvoiceId } = completed(await executeIssuanceCommand(createInvoiceFromDeliverables, { agreementId: ctx.agreement.id, deliverableIds: [ctx.id()] }, { actor }))
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: saleInvoiceId! }, include: { items: true } })
    expect(before.number).toBeNull()
    expect(await executeIssuanceCommand(deleteInvoiceDraft, { id: saleInvoiceId! }, { actor })).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
    const input = await ctx.releaseInput()
    const options = { actor, clientRequestId: "member-release" }
    const outcome = await executeIssuanceCommand(releaseDeliverableReservation, input, options)
    expect(completed(outcome)).toEqual({ invoiceId: saleInvoiceId, invoiceNumber: null, remainingLines: 0 })
    const empty = await prisma.invoice.findUniqueOrThrow({ where: { id: saleInvoiceId! }, include: { items: true } })
    expect(empty).toEqual({ ...before, updatedAt: expect.any(Date), items: [], subtotalNet: new Prisma.Decimal(0), totalTax: new Prisma.Decimal(0), totalGross: new Prisma.Decimal(0) })
    expect(await ctx.view()).toMatchObject({ state: "unbilled", generation: 0, holder: null })
    // An idempotent replay returns the original decision; a new attempt cannot release twice.
    expect(await executeIssuanceCommand(releaseDeliverableReservation, input, options)).toEqual(outcome)
    refused(await executeIssuanceCommand(releaseDeliverableReservation, input, { actor }), "not_reserved")
    expect(await events(ctx, "deliverable.released")).toBe(1)
    expect(await events(ctx, "invoice.draft_updated")).toBe(1)
    expect(await events(ctx, "invoice.draft_deleted")).toBe(0)
    // The same empty draft is reusable. An old review cannot release its new line identity.
    completed(await executeIssuanceCommand(addInvoiceDeliverables, { id: saleInvoiceId!, agreementId: ctx.agreement.id, deliverableIds: [ctx.id()] }, { actor }))
    refused(await executeIssuanceCommand(releaseDeliverableReservation, input, { actor }), "allocation_changed")
    const current = await ctx.releaseInput()
    expect(current.expectedAllocation.invoiceItemId).not.toBe(input.expectedAllocation.invoiceItemId)
    refused(await executeIssuanceCommand(releaseDeliverableReservation, { ...current, expectedAllocation: { ...current.expectedAllocation, generation: 1 } }, { actor }), "allocation_changed")
    await ctx.issue(saleInvoiceId!)
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: saleInvoiceId! } })).number).toBe("INV-0001")
    await expectConsistentAllocations(ctx)
  })

  it("refuses to release work that is already on an issued invoice", async () => {
    const ctx = await setup(1)
    const { saleInvoiceId } = completed(await ctx.reserve([ctx.id(0)]))
    await ctx.issue(saleInvoiceId!)
    refused(await executeIssuanceCommand(releaseDeliverableReservation, await ctx.releaseInput(), { actor: ctx.actor }), "not_reserved")
    expect((await ctx.line()).billingStatus).toBe("invoiced")
    expect(await events(ctx, "deliverable.released")).toBe(0)
  })

  it.each(["email", "without email"])("refuses an empty draft through real issuance %s before numbering, artifacts or delivery", async (mode) => {
    const ctx = await setup(1)
    const actor = ctx.org.actors.member
    const { saleInvoiceId } = completed(await ctx.reserve([ctx.id()]))
    completed(await executeIssuanceCommand(releaseDeliverableReservation, await ctx.releaseInput(), { actor }))
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: saleInvoiceId! }, include: { items: true } })
    expect(before).toMatchObject({ status: "draft", number: null, items: [] })
    const counter = (await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })).invoiceNextNum
    const jobsBefore = await prisma.job.count({ where: { organizationId: ctx.org.organizationId } })
    const render = vi.spyOn(getDocumentRenderer()!, "renderPdf")
    const store = vi.spyOn(getDocumentArtifactStore()!, "put")
    vi.mocked(deliver).mockClear()
    if (mode === "without email") vi.stubEnv("RESEND_API_KEY", "")
    const commandInput = { id: saleInvoiceId!, allowSendWithoutEmail: mode === "without email" }
    const outcome = await executeIssuanceCommand(sendInvoice, commandInput, { actor })
    refused(outcome, "empty_invoice")
    expect(outcome).toMatchObject({ error: { message: "Add at least one line before sending this invoice." } })
    // The low-level command cannot bypass the issuance protocol either.
    refused(await executeCommand(sendInvoice, commandInput, { actor }), "issuance_required")
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: saleInvoiceId! }, include: { items: true } })).toEqual(before)
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })).invoiceNextNum).toBe(counter)
    expect(await prisma.artifactStaging.count({ where: { documentId: saleInvoiceId! } })).toBe(0)
    expect(await prisma.issuanceCandidate.count({ where: { documentId: saleInvoiceId! } })).toBe(0)
    expect(await prisma.job.count({ where: { organizationId: ctx.org.organizationId } })).toBe(jobsBefore)
    expect(await events(ctx, "invoice.issued")).toBe(0)
    expect(await events(ctx, "invoice.sent")).toBe(0)
    expect(await events(ctx, "document.number_voided")).toBe(0)
    expect(render).not.toHaveBeenCalled()
    expect(store).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
    // Empty drafts can still be previewed, without taking a number or publishing an artifact.
    const preview = await documentPdf("invoice", saleInvoiceId!, ctx.org.organizationId)
    expect(preview.status).toBe(200)
    expect(preview.headers.get("X-Quits-Artifact")).toBe("live")
    expect(await preview.json()).toMatchObject({ pdf: { invoice: { status: "draft", number: "", items: [] } } })
    expect(store).not.toHaveBeenCalled()
  })

  it("refuses a prepared send when a member releases the final line before commit", async () => {
    const ctx = await setup(1)
    const { saleInvoiceId } = completed(await ctx.reserve([ctx.id()]))
    const actor = ctx.org.actors.member
    const args = { kind: "invoice" as const, actor, clientRequestId: "prepared-send", commandInput: { id: saleInvoiceId! } }
    const staged = await reserveDocument(args)
    await prepareDocument(staged.id)
    completed(await executeIssuanceCommand(releaseDeliverableReservation, await ctx.releaseInput(), { actor }))
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: saleInvoiceId! }, include: { items: true } })
    vi.mocked(deliver).mockClear()
    const render = vi.spyOn(getDocumentRenderer()!, "renderPdf")
    const store = vi.spyOn(getDocumentArtifactStore()!, "put")
    refused(await executeCommand(sendInvoice, args.commandInput, { actor, clientRequestId: args.clientRequestId, issuanceStagingId: staged.id }), "empty_invoice")
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: saleInvoiceId! }, include: { items: true } })).toEqual(before)
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.organizationId } })).invoiceNextNum).toBe(1)
    expect(await prisma.issuanceCandidate.count({ where: { documentId: saleInvoiceId! } })).toBe(0)
    expect((await prisma.artifactStaging.findUniqueOrThrow({ where: { id: staged.id } })).status).toBe("stored")
    expect(await events(ctx, "invoice.issued")).toBe(0)
    expect(await events(ctx, "invoice.sent")).toBe(0)
    expect(render).not.toHaveBeenCalled()
    expect(store).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  })

  it("keeps last-line member recovery tenant scoped", async () => {
    const ctx = await setup(1)
    const foreign = await createTestOrganization({ roles: ["member"] }); cleanups.push(foreign.cleanup)
    const { saleInvoiceId } = completed(await ctx.reserve([ctx.id()]))
    const input = await ctx.releaseInput()
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: saleInvoiceId! }, include: { items: true } })
    expect(await executeIssuanceCommand(releaseDeliverableReservation, input, { actor: foreign.actors.member })).toMatchObject({ status: "failed", error: { tag: "NotFound" } })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: saleInvoiceId! }, include: { items: true } })).toEqual(before)
    expect(await events(ctx, "deliverable.released")).toBe(0)
    expect(await ctx.view()).toMatchObject({ state: "reserved", generation: 0, holder: { invoiceId: saleInvoiceId } })
    completed(await executeIssuanceCommand(releaseDeliverableReservation, input, { actor: ctx.org.actors.member }))
    await expectConsistentAllocations(ctx)
  })

  it("refuses last-line member recovery while the actual send is in flight and after issuance", async () => {
    const ctx = await setup(1)
    const { saleInvoiceId } = completed(await ctx.reserve([ctx.id()]))
    const input = await ctx.releaseInput()
    let settle!: (result: { id: string }) => void
    vi.mocked(deliver).mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
    const sending = issueDocument({ kind: "invoice", actor: ctx.org.actors.member, commandInput: { id: saleInvoiceId! } })
    try {
      await vi.waitFor(() => expect(settle).toBeTypeOf("function"))
      const before = await prisma.invoice.findUniqueOrThrow({ where: { id: saleInvoiceId! }, include: { items: true } })
      expect(before).toMatchObject({ status: "draft", lastEmailAttemptOutcome: "sending" })
      refused(await executeIssuanceCommand(releaseDeliverableReservation, input, { actor: ctx.org.actors.member }), "send_in_progress")
      expect(await prisma.invoice.findUniqueOrThrow({ where: { id: saleInvoiceId! }, include: { items: true } })).toEqual(before)
      expect(await events(ctx, "deliverable.released")).toBe(0)
    } finally {
      settle?.({ id: "synthetic-member-send" })
      await sending
    }
    completed(await sending)
    const issued = await prisma.invoice.findUniqueOrThrow({ where: { id: saleInvoiceId! }, include: { items: true } })
    expect(issued).toMatchObject({ status: "sent", number: "INV-0001", items: [expect.objectContaining({ deliverableId: ctx.id() })] })
    refused(await executeIssuanceCommand(releaseDeliverableReservation, input, { actor: ctx.org.actors.member }), "not_reserved")
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: saleInvoiceId! }, include: { items: true } })).toEqual(issued)
    expect(await events(ctx, "deliverable.released")).toBe(0)
    await expectConsistentAllocations(ctx)
  })

  it("refuses a release reviewed against A after the work moves to B", async () => {
    const ctx = await setup(2)
    const { saleInvoiceId: first } = completed(await ctx.reserve([ctx.id(), ctx.id(1)]))
    const item = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: first! } })
    const reviewed = { agreementId: ctx.agreement.id, deliverableId: ctx.id(), expectedAllocation: { invoiceId: first!, invoiceItemId: item.id, generation: 0 } }
    completed(await executeIssuanceCommand(releaseDeliverableReservation, reviewed, { actor: ctx.actor }))
    const { saleInvoiceId: second } = completed(await ctx.reserve([ctx.id()]))
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: second! }, include: { items: true } })
    refused(await executeIssuanceCommand(releaseDeliverableReservation, reviewed, { actor: ctx.actor }), "allocation_changed")
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: second! }, include: { items: true } })).toEqual(before)
    expect((await ctx.line()).billingStatus).toBe("reserved")
    expect(await events(ctx, "deliverable.released")).toBe(1)
    await expectConsistentAllocations(ctx)
  })

  it("refuses an old line identity even when the same draft reserves the work again", async () => {
    const ctx = await setup(2)
    const { saleInvoiceId } = completed(await ctx.reserve([ctx.id(0), ctx.id(1)]))
    const reviewed = await ctx.releaseInput()
    completed(await executeIssuanceCommand(releaseDeliverableReservation, reviewed, { actor: ctx.actor }))
    completed(await executeIssuanceCommand(addInvoiceDeliverables, { id: saleInvoiceId!, agreementId: ctx.agreement.id, deliverableIds: [ctx.id()] }, { actor: ctx.actor }))
    const current = await ctx.releaseInput()
    expect(current.expectedAllocation.invoiceId).toBe(reviewed.expectedAllocation.invoiceId)
    expect(current.expectedAllocation.invoiceItemId).not.toBe(reviewed.expectedAllocation.invoiceItemId)
    refused(await executeIssuanceCommand(releaseDeliverableReservation, reviewed, { actor: ctx.actor }), "allocation_changed")
    expect(await prisma.invoiceItem.findUnique({ where: { id: current.expectedAllocation.invoiceItemId } })).not.toBeNull()
    expect(await events(ctx, "deliverable.released")).toBe(1)
    await expectConsistentAllocations(ctx)
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
    const ctx = await setup(2)
    completed(await ctx.reserve([ctx.id(0), ctx.id(1)]))
    const input = await ctx.releaseInput()
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

  it("refuses a selected partial note even when another note completes the credit", async () => {
    const ctx = await setup(1)
    const { saleInvoiceId } = completed(await ctx.reserve([ctx.id()]))
    await ctx.issue(saleInvoiceId!)
    const item = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: saleInvoiceId! } })
    const first = completed(await creditLine(ctx, saleInvoiceId!, item.id, "0.4"))
    completed(await creditLine(ctx, saleInvoiceId!, item.id, "0.6"))
    refused(await executeIssuanceCommand(authorizeDeliverableRebill, { agreementId: ctx.agreement.id, deliverableId: ctx.id(), creditNoteId: first.id, reason: "Reviewed only the first note" }, { actor: ctx.actor }), "line_not_fully_credited")
    expect(await ctx.line()).toMatchObject({ billingStatus: "invoiced", billingGeneration: 0 })
    expect(await prisma.deliverableRebill.count({ where: { agreementId: ctx.agreement.id } })).toBe(0)
    expect(await events(ctx, "deliverable.rebill_authorized")).toBe(0)
  })

  it("persists the complete reviewed credit set for cumulative full-credit rebilling", async () => {
    const ctx = await setup(1)
    const { saleInvoiceId } = completed(await ctx.reserve([ctx.id()]))
    await ctx.issue(saleInvoiceId!)
    const item = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: saleInvoiceId! } })
    const first = completed(await creditLine(ctx, saleInvoiceId!, item.id, "0.4"))
    const second = completed(await creditLine(ctx, saleInvoiceId!, item.id, "0.6"))
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: saleInvoiceId! }, include: { items: true, creditNotes: { include: { items: true } } } })
    expect(await ctx.view()).toMatchObject({ state: "credited", creditedQuantity: "1", rebill: { eligible: true }, creditNotes: expect.arrayContaining([{ id: first.id, number: first.number }, { id: second.id, number: second.number }]) })
    const input = { agreementId: ctx.agreement.id, deliverableId: ctx.id(), creditNoteId: first.id, creditNoteIds: [first.id, second.id], reason: "Both corrections reviewed for redelivery" }
    for (const creditNoteIds of [[first.id, first.id, second.id], [second.id]])
      expect(await executeIssuanceCommand(authorizeDeliverableRebill, { ...input, creditNoteIds }, { actor: ctx.actor })).toMatchObject({ status: "failed", error: { tag: "ValidationFailed" } })
    refused(await executeIssuanceCommand(authorizeDeliverableRebill, { ...input, creditNoteIds: [first.id, second.id, "unrelated-credit"] }, { actor: ctx.actor }), "credit_note_mismatch")
    expect(await prisma.deliverableRebill.count({ where: { agreementId: ctx.agreement.id } })).toBe(0)
    completed(await executeIssuanceCommand(authorizeDeliverableRebill, input, { actor: ctx.actor }))
    expect(await prisma.deliverableRebill.findFirstOrThrow({ where: { deliverableId: ctx.id() } })).toMatchObject({ priorInvoiceItemId: item.id, creditNoteIds: [first.id, second.id], reason: input.reason })
    expect(await ctx.view()).toMatchObject({ state: "unbilled", generation: 1, rebills: [{ creditNotes: [{ id: first.id, number: first.number }, { id: second.id, number: second.number }] }] })
    expect(await prisma.domainEvent.findFirstOrThrow({ where: { organizationId: ctx.org.organizationId, type: "deliverable.rebill_authorized" } })).toMatchObject({ schemaVersion: 2, payload: { creditNoteIds: [first.id, second.id] } })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: saleInvoiceId! }, include: { items: true, creditNotes: { include: { items: true } } } })).toEqual(before)
    completed(await ctx.reserve([ctx.id()]))
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

  it.each(["completed", "cancelled"] as const)("refuses rebilling on a %s agreement without changing billing, history or events", async disposition => {
    const ctx = await setup(1)
    const { saleInvoiceId } = completed(await ctx.reserve([ctx.id()]))
    await ctx.issue(saleInvoiceId!)
    const item = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: saleInvoiceId! } })
    const credit = completed(await creditLine(ctx, saleInvoiceId!, item.id, "1"))
    completed(await executeIssuanceCommand(closeAgreement, { id: ctx.agreement.id, disposition, reason: "Work ended" }, { actor: ctx.actor }))
    const before = await ctx.line()
    const eventCount = await events(ctx, "deliverable.rebill_authorized")
    refused(await executeIssuanceCommand(authorizeDeliverableRebill, { agreementId: ctx.agreement.id, deliverableId: ctx.id(), creditNoteId: credit.id, reason: "Bill again" }, { actor: ctx.actor }), "agreement_not_accepted")
    expect(await ctx.line()).toEqual(before)
    expect(await prisma.deliverableRebill.count({ where: { agreementId: ctx.agreement.id } })).toBe(0)
    expect(await events(ctx, "deliverable.rebill_authorized")).toBe(eventCount)
    expect(await ctx.view()).toMatchObject({ state: "credited", rebill: { eligible: false, blocker: "agreement_not_accepted" } })
    expect((await prisma.agreement.findUniqueOrThrow({ where: { id: ctx.agreement.id } })).status).toBe(disposition)
  })

  it("redacts historical document references in actual scoped agreement and deliverable query responses", async () => {
    const ctx = await setup(1)
    const { saleInvoiceId } = completed(await ctx.reserve([ctx.id()]))
    await ctx.issue(saleInvoiceId!)
    const item = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: saleInvoiceId! } })
    const credit = completed(await creditLine(ctx, saleInvoiceId!, item.id, "0.4"))
    const second = completed(await creditLine(ctx, saleInvoiceId!, item.id, "0.6"))
    completed(await executeIssuanceCommand(authorizeDeliverableRebill, { agreementId: ctx.agreement.id, deliverableId: ctx.id(), creditNoteId: credit.id, creditNoteIds: [credit.id, second.id], reason: "Rework approved" }, { actor: ctx.actor }))
    for (const [name, permission, input] of [
      ["agreement_get", "agreement:read", { id: ctx.agreement.id }],
      ["deliverable_list", "deliverable:read", { agreementId: ctx.agreement.id }],
    ] as const) {
      for (const [invoices, credits] of [[false, false], [true, false], [false, true], [true, true]]) {
        const key = await createAgentKey(ctx.actor, { name: "Scoped reader", mode: "read_only", scopes: [permission, ...(invoices ? ["invoice:read"] : []), ...(credits ? ["creditNote:read"] : [])], expiresInDays: null })
        const actor = await authenticateAgentSecret(key.secret)
        const result = await runAgentTool(actor, name, input)
        expect(result.ok).toBe(true)
        if (!result.ok) throw new Error(result.error.message)
        const output = result.value as { deliverables: Array<{ allocation: { rebills: unknown[] } }> } | Array<{ allocation: { rebills: unknown[] } }>
        const lines = Array.isArray(output) ? output : output.deliverables
        expect(lines[0]!.allocation.rebills[0]).toMatchObject({ priorInvoiceId: invoices ? saleInvoiceId : null, priorInvoiceNumber: invoices ? expect.any(String) : null, creditNoteId: credits ? credit.id : null, creditNoteNumber: credits ? expect.any(String) : null, creditNotes: credits ? [{ id: credit.id, number: credit.number }, { id: second.id, number: second.number }] : [] })
        if (!invoices) expect(JSON.stringify(output)).not.toContain(saleInvoiceId!)
        if (!credits) { expect(JSON.stringify(output)).not.toContain(credit.id); expect(JSON.stringify(output)).not.toContain(second.id) }
      }
    }
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

describe.runIf(hasTestDatabase)("allocation read snapshots", () => {
  it.each(["page", "agreement_get", "deliverable_list"] as const)("%s stays consistent across a concurrent release, reservation and rebill", async endpoint => {
    const ctx = await setup(2)
    const key = await createAgentKey(ctx.actor, { name: "Snapshot reader", mode: "read_only", scopes: ["agreement:read", "deliverable:read", "invoice:read", "creditNote:read"], expiresInDays: null })
    const actor = await authenticateAgentSecret(key.secret)
    const caller = appRouter.createCaller({ session: { user: { id: ctx.actor.userId, name: "Test", email: "test@example.test" }, session: { activeOrganizationId: ctx.org.organizationId } } } as never)
    const read = async () => {
      if (endpoint === "page") return (await caller.agreements.get({ id: ctx.agreement.id })).deliverables[0]!
      const response = await runAgentTool(actor, endpoint, endpoint === "agreement_get" ? { id: ctx.agreement.id } : { agreementId: ctx.agreement.id })
      if (!response.ok) throw new Error(response.error.message)
      type Row = { billingStatus: string; billingGeneration: number; allocation: Awaited<ReturnType<Ctx["view"]>> }
      const result = response.value as { deliverables: Row[] } | Row[]
      return (Array.isArray(result) ? result : result.deliverables)[0]!
    }
    const interleave = async (mutation: () => Promise<unknown>) => {
      let changed = false
      // Real PostgreSQL writes commit after the agreement SELECT, before allocation SELECTs.
      // The extension also intercepts queries inside an interactive transaction.
      const client = getPrisma().$extends({ query: { agreement: { async findFirst({ args, query }) {
        const result = await query(args)
        if (!changed && args.where?.id === ctx.agreement.id) { changed = true; await mutation() }
        return result
      } } } })
      setRuntimePlatform({ ...defaultNodePlatform, getPrisma: () => client })
      try { const result = await read(); expect(changed).toBe(true); return result }
      finally { resetRuntimePlatform() }
    }
    const { saleInvoiceId } = completed(await ctx.reserve([ctx.id(), ctx.id(1)]))
    const other = await setup(1)
    if (endpoint === "page") await expect(caller.agreements.get({ id: other.agreement.id })).rejects.toMatchObject({ message: "Agreement not found" })
    else expect(await runAgentTool(actor, endpoint, endpoint === "agreement_get" ? { id: other.agreement.id } : { agreementId: other.agreement.id })).toMatchObject({ ok: false })
    const releaseInput = await ctx.releaseInput()
    const reserved = await interleave(async () => completed(await executeIssuanceCommand(releaseDeliverableReservation, releaseInput, { actor: ctx.actor })))
    expect(reserved).toMatchObject({ billingStatus: "reserved", billingGeneration: 0, allocation: { state: "reserved", generation: 0, holder: { invoiceId: saleInvoiceId }, rebills: [] } })
    expect(await read()).toMatchObject({ billingStatus: "unbilled", allocation: { state: "unbilled", holder: null } })

    const unbilled = await interleave(async () => completed(await executeIssuanceCommand(addInvoiceDeliverables, { id: saleInvoiceId!, agreementId: ctx.agreement.id, deliverableIds: [ctx.id()] }, { actor: ctx.actor })))
    expect(unbilled).toMatchObject({ billingStatus: "unbilled", allocation: { state: "unbilled", holder: null, rebills: [] } })
    expect(await read()).toMatchObject({ billingStatus: "reserved", allocation: { state: "reserved", holder: { invoiceId: saleInvoiceId } } })

    await ctx.issue(saleInvoiceId!)
    const item = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: saleInvoiceId!, deliverableId: ctx.id() } })
    const credit = completed(await executeIssuanceCommand(issueCreditNote, { invoiceId: saleInvoiceId!, mode: "lines", lines: [{ invoiceItemId: item.id, quantity: "1" }], reason: "Correction" }, { actor: ctx.actor }))
    const credited = await interleave(async () => completed(await executeIssuanceCommand(authorizeDeliverableRebill, { agreementId: ctx.agreement.id, deliverableId: ctx.id(), creditNoteId: credit.id, reason: "Reviewed redelivery" }, { actor: ctx.actor })))
    expect(credited).toMatchObject({ billingStatus: "invoiced", billingGeneration: 0, allocation: { state: "credited", generation: 0, holder: { invoiceId: saleInvoiceId }, rebills: [] } })
    expect(await read()).toMatchObject({ billingStatus: "unbilled", billingGeneration: 1, allocation: { state: "unbilled", generation: 1, holder: null, rebills: [{ generation: 1 }] } })
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
