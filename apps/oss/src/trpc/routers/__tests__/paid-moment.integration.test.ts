import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { invoicePaidMomentResultSchema } from "@quits/contracts/invoices"
import { executeIssuanceCommand } from "../../../application/issuance"
import { agentTools } from "../../../domain/agent-tools/registry"
import type { Actor } from "../../../domain/actor"
import { createContact } from "../../../domain/commands/contacts"
import { issueCreditNote } from "../../../domain/commands/credit-notes"
import { createInvoiceDraft, sendInvoice } from "../../../domain/commands/invoices"
import { markInvoicePaid, undoInvoiceMarkPaid } from "../../../domain/commands/paid-moment"
import { recordPayment, recordStripeCheckoutPayment, voidPayment } from "../../../domain/commands/payments"
import { reminderBlocker } from "../../../domain/commands/reminders"
import { allocateReceipt, previewReceiptAllocation, recordReceipt } from "../../../domain/commands/settlements"
import { EXPIRE_CHECKOUT_SESSION_JOB } from "../../../domain/documents/checkout-sessions"
import { executeCommand, type CommandOutcome } from "../../../domain/execute"
import { runJobsNow } from "../../../domain/jobs"
import { getCommandDefinition } from "../../../domain/registry"
import { prisma } from "../../../lib/db"
import { encryptSecret } from "../../../lib/secrets"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

const expireCheckout = vi.hoisted(() => vi.fn().mockResolvedValue("expired"))
vi.mock("../../../lib/payments/stripe", async importOriginal => ({
  ...await importOriginal<typeof import("../../../lib/payments/stripe")>(),
  expireOpenStripeCheckoutSession: expireCheckout,
}))
const now = new Date("2026-10-09T23:30:00.000Z")
const load = (id: string) => prisma.invoice.findUniqueOrThrow({ where: { id } })
function completed<T>(outcome: CommandOutcome<T>): T {
  if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome))
  return outcome.result
}
function caller(actor: Extract<Actor, { kind: "user" }>) {
  return appRouter.createCaller({ session: {
    user: { id: actor.userId, name: actor.label, email: `${actor.userId}@example.test` },
    session: { activeOrganizationId: actor.organizationId },
  } } as never)
}
const mark = (actor: Actor, invoiceId: string, requestId = randomUUID(), at = now) =>
  executeCommand(markInvoicePaid, { invoiceId, requestId }, {
    actor, clientRequestId: `invoice.mark_paid:${invoiceId}:${requestId}`, now: at,
  })
const undo = (actor: Actor, invoiceId: string, paymentId: string, requestId = randomUUID(), at = now) =>
  executeCommand(undoInvoiceMarkPaid, { invoiceId, paymentId, requestId }, {
    actor, clientRequestId: `invoice.undo_mark_paid:${invoiceId}:${paymentId}:${requestId}`, now: at,
  })

describe.skipIf(!hasTestDatabase)("paid moment", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
    expireCheckout.mockClear()
  })
  async function setup(options: { currency?: string; total?: number; dueDate?: string; draft?: boolean } = {}) {
    const org = await createTestOrganization({ roles: ["admin", "member"], settings: {
      currency: options.currency ?? "DKK", timezone: "Europe/Copenhagen",
    } })
    cleanups.push(org.cleanup)
    const actor = org.actors.admin
    const contact = completed(await executeCommand(createContact, { name: "Nordlys Studio", email: "nordlys@example.test" }, { actor }))
    const invoice = completed(await executeCommand(createInvoiceDraft, {
      contactId: contact.id, currency: options.currency ?? "DKK", dueDate: options.dueDate ?? "2099-01-01", taxRate: 0,
      items: [{ description: "Design", quantity: 2, unitPrice: (options.total ?? 1000) / 2 }],
    }, { actor }))
    if (!options.draft) completed(await executeIssuanceCommand(sendInvoice, { id: invoice.id, allowSendWithoutEmail: true }, { actor }))
    return { org, actor, invoiceId: invoice.id, contactId: contact.id }
  }
  const record = (actor: Actor, invoiceId: string, amount: number) => executeCommand(recordPayment, {
    invoiceId, amount, paidAt: "2026-10-01", method: "bank_transfer",
  }, { actor, now })

  it("fully settles, uses today's organization date, and retains audited rows on undo", async () => {
    const { actor, invoiceId } = await setup()
    const marked = completed(await mark(actor, invoiceId))
    expect(invoicePaidMomentResultSchema.parse(marked)).toEqual({
      paymentId: expect.any(String), invoiceStatus: "paid", balance: { amount: "0.00", currency: "DKK" },
      total: { amount: "1000.00", currency: "DKK" }, paidFraction: "1", undoUntil: "2026-10-09T23:40:00.000Z",
    })
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: marked.paymentId } })
    expect(payment).toMatchObject({ method: "manual", source: "user", receiptId: null, voidedAt: null })
    // Oct 10 in Copenhagen starts at 22:00 UTC on Oct 9.
    expect(payment.paidAt.toISOString()).toBe("2026-10-09T22:00:00.000Z")
    expect(reminderBlocker(await load(invoiceId))).toBe("not_open")
    const reversed = completed(await undo(actor, invoiceId, payment.id))
    expect(reversed).toEqual({ ...marked, invoiceStatus: "sent", balance: { amount: "1000.00", currency: "DKK" }, paidFraction: "0" })
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ voidReason: "Fortrudt", voidedAt: now, amount: payment.amount })
    expect(reminderBlocker(await load(invoiceId))).toBeNull()
    const events = await prisma.domainEvent.findMany({ where: { aggregateId: invoiceId }, orderBy: { sequence: "asc" } })
    expect(events.slice(-4).map(e => e.type)).toEqual(["payment.recorded", "invoice.paid", "invoice.marked_paid", "payment.voided"])
    const recorded = events.find(e => e.type === "payment.recorded")!
    const voided = events.at(-1)!
    expect(recorded).toMatchObject({ actorKind: "user", actorId: actor.userId, schemaVersion: 1 })
    expect(voided).toMatchObject({ actorKind: "user", actorId: actor.userId, payload: { paymentId: payment.id, reason: "Fortrudt", balanceDue: "1000.00" } })
    for (const event of [recorded, voided]) {
      expect(await prisma.commandReceipt.findUnique({ where: { id: event.commandId! } })).toMatchObject({ status: "completed" })
    }
  })

  it("settles only the remainder after an earlier payment", async () => {
    const { actor, invoiceId } = await setup()
    const earlier = completed(await record(actor, invoiceId, 123.45))
    const marked = completed(await mark(actor, invoiceId))
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: marked.paymentId } })).amount.toFixed(2)).toBe("876.55")
    const reversed = completed(await undo(actor, invoiceId, marked.paymentId))
    expect(reversed).toMatchObject({ balance: { amount: "876.55" }, paidFraction: "0.12345" })
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: earlier.payment.id } })).voidedAt).toBeNull()
  })

  it("settles receipt-funded remainder and never reverses the allocation", async () => {
    const { actor, invoiceId, contactId } = await setup()
    const evidence = { reason: "Bank statement", evidence: "https://evidence.example.test/1" }
    const receipt = completed(await executeCommand(recordReceipt, {
      requestId: randomUUID(), contactId, currency: "DKK", netAmount: "400", feeAmount: "0",
      method: "bank_transfer", paidAt: "2026-10-01", reference: randomUUID(), ...evidence,
    }, { actor, now }))
    const allocation = { requestId: randomUUID(), receiptId: receipt.receiptId,
      allocations: [{ invoiceId, receiptAmount: "400", invoiceAmount: "400" }], ...evidence }
    const preview = await prisma.$transaction(db => previewReceiptAllocation(db, actor.organizationId, allocation))
    completed(await executeCommand(allocateReceipt, { ...allocation, previewToken: preview.previewToken }, { actor, now }))
    const allocated = await prisma.payment.findFirstOrThrow({ where: { receiptId: receipt.receiptId } })
    const marked = completed(await mark(actor, invoiceId))
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: marked.paymentId } })).amount.toFixed(2)).toBe("600.00")
    expect(await undo(actor, invoiceId, allocated.id)).toMatchObject({ status: "failed", error: { code: "receipt_allocation_requires_reversal" } })
    expect(await executeCommand(voidPayment, { paymentId: allocated.id, reason: "Test" }, { actor })).toMatchObject({ status: "failed", error: { code: "receipt_allocation_requires_reversal" } })
    expect(completed(await undo(actor, invoiceId, marked.paymentId))).toMatchObject({ balance: { amount: "600.00" }, paidFraction: "0.4" })
    expect(await prisma.payment.findUnique({ where: { id: allocated.id } })).toEqual(allocated)
  })

  it("includes issued credits in the remaining balance and progress", async () => {
    const { actor, invoiceId } = await setup()
    const item = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId } })
    completed(await executeIssuanceCommand(issueCreditNote, {
      invoiceId, mode: "lines", lines: [{ invoiceItemId: item.id, quantity: 1 }], reason: "Half cancelled",
    }, { actor }))
    const marked = completed(await mark(actor, invoiceId))
    expect((await load(invoiceId)).amountPaid.toFixed(2)).toBe("500.00")
    expect(completed(await undo(actor, invoiceId, marked.paymentId))).toMatchObject({ balance: { amount: "500.00" }, total: { amount: "1000.00" }, paidFraction: "0.5" })
    expect((await load(invoiceId)).amountCredited.toFixed(2)).toBe("500.00")
  })

  it("replays a concurrent double click through the router, even after undo", async () => {
    const { actor, invoiceId } = await setup()
    const api = caller(actor)
    const input = { invoiceId, requestId: randomUUID() }
    const results = await Promise.all([api.invoices.markPaid(input), api.invoices.markPaid(input)])
    expect(results[0]).toEqual(results[1])
    expect(await prisma.payment.count({ where: { invoiceId } })).toBe(1)
    const undoInput = { ...input, paymentId: results[0].paymentId }
    // Command-scoped keys permit reusing the request text for a distinct undo intent.
    const undone = await Promise.all([api.invoices.undoMarkPaid(undoInput), api.invoices.undoMarkPaid(undoInput)])
    expect(undone[0]).toEqual(undone[1])
    expect(await api.invoices.markPaid(input)).toEqual(results[0])
    expect(await prisma.domainEvent.count({ where: { aggregateId: invoiceId, type: "payment.voided" } })).toBe(1)
    expect((await load(invoiceId)).amountPaid.toFixed(2)).toBe("0.00")
  })

  it("reusing a request ID on another invoice records and reverses each payment", async () => {
    const { actor, invoiceId, contactId } = await setup()
    const api = caller(actor)
    const second = await api.invoices.create({
      contactId, dueDate: "2099-01-01", taxRate: 0,
      items: [{ description: "Another invoice", quantity: 1, unitPrice: 250 }],
    })
    await api.invoices.send({ id: second.id, allowSendWithoutEmail: true })
    const requestId = randomUUID()
    const firstPaid = await api.invoices.markPaid({ invoiceId, requestId })
    const secondPaid = await api.invoices.markPaid({ invoiceId: second.id, requestId })
    expect(secondPaid.paymentId).not.toBe(firstPaid.paymentId)
    expect(secondPaid).toMatchObject({ invoiceStatus: "paid", total: { amount: "250.00" }, balance: { amount: "0.00" } })
    expect((await load(second.id)).amountPaid.toFixed(2)).toBe("250.00")
    expect(await prisma.payment.findUnique({ where: { id: secondPaid.paymentId } })).toMatchObject({ invoiceId: second.id })
    const firstUndo = await api.invoices.undoMarkPaid({ invoiceId, paymentId: firstPaid.paymentId, requestId })
    const secondUndo = await api.invoices.undoMarkPaid({ invoiceId: second.id, paymentId: secondPaid.paymentId, requestId })
    expect(firstUndo.balance.amount).toBe("1000.00")
    expect(secondUndo).toMatchObject({ paymentId: secondPaid.paymentId, balance: { amount: "250.00" } })
    expect((await load(second.id)).amountPaid.toFixed(2)).toBe("0.00")
  })

  it("reusing an undo request ID for a later payment on the same invoice reverses that payment", async () => {
    const { actor, invoiceId } = await setup()
    const api = caller(actor)
    const requestId = randomUUID()
    const first = await api.invoices.markPaid({ invoiceId, requestId: randomUUID() })
    const firstUndo = await api.invoices.undoMarkPaid({ invoiceId, paymentId: first.paymentId, requestId })
    const second = await api.invoices.markPaid({ invoiceId, requestId: randomUUID() })
    expect(second.paymentId).not.toBe(first.paymentId)
    const secondUndo = await api.invoices.undoMarkPaid({ invoiceId, paymentId: second.paymentId, requestId })
    expect(secondUndo).toMatchObject({ paymentId: second.paymentId, balance: { amount: "1000.00" } })
    expect(await prisma.payment.count({ where: { invoiceId, voidedAt: null } })).toBe(0)
    expect(await api.invoices.undoMarkPaid({ invoiceId, paymentId: first.paymentId, requestId })).toEqual(firstUndo)
    expect(await api.invoices.undoMarkPaid({ invoiceId, paymentId: second.paymentId, requestId })).toEqual(secondUndo)
  })

  it("two different request IDs settle once and refuse the other", async () => {
    const { actor, invoiceId } = await setup()
    const outcomes = await Promise.all([mark(actor, invoiceId), mark(actor, invoiceId)])
    expect(outcomes.filter(o => o.status === "completed")).toHaveLength(1)
    expect(outcomes.find(o => o.status === "failed")).toMatchObject({ error: { code: "already_settled" } })
    expect(await prisma.payment.count({ where: { invoiceId } })).toBe(1)
  })

  it("restores overdue status and reminder eligibility", async () => {
    const { actor, invoiceId } = await setup({ dueDate: "2026-01-01" })
    const marked = completed(await mark(actor, invoiceId))
    expect(completed(await undo(actor, invoiceId, marked.paymentId))).toMatchObject({ invoiceStatus: "overdue", balance: { amount: "1000.00" } })
    expect(reminderBlocker(await load(invoiceId))).toBeNull()
  })

  it("undo leaves a later Stripe payment in place and recomputes exactly", async () => {
    const { actor, invoiceId } = await setup()
    const marked = completed(await mark(actor, invoiceId))
    // A checkout already in flight may collect after a manual settlement.
    const other = completed(await executeCommand(recordStripeCheckoutPayment, {
      invoiceId, checkoutSessionId: `cs_${invoiceId}`, paymentIntentId: null,
      amount: 250.25, currency: "DKK", paidAt: now.toISOString(),
    }, { actor: { kind: "system", organizationId: actor.organizationId, reason: "stripe_webhook", label: "Stripe" }, now }))
    expect(completed(await undo(actor, invoiceId, marked.paymentId))).toMatchObject({ balance: { amount: "749.75" }, paidFraction: "0.25025", invoiceStatus: "sent" })
    expect(await prisma.payment.findMany({ where: { invoiceId, voidedAt: null } })).toEqual([other.payment])
  })

  it.each([599_999, 600_000, 600_001])("enforces the server deadline at %i ms", async elapsed => {
    const { actor, invoiceId } = await setup()
    const marked = completed(await mark(actor, invoiceId))
    const outcome = await undo(actor, invoiceId, marked.paymentId, randomUUID(), new Date(now.getTime() + elapsed))
    if (elapsed < 600_000) expect(outcome.status).toBe("completed")
    else {
      expect(outcome).toMatchObject({ status: "failed", error: { code: "undo_expired" } })
      expect((await load(invoiceId)).status).toBe("paid")
      expect((await executeCommand(voidPayment, { paymentId: marked.paymentId, reason: "Correction after deadline" }, { actor })).status).toBe("completed")
    }
  })

  it("replays an undo after its deadline but refuses a new undo request", async () => {
    const { actor, invoiceId } = await setup()
    const marked = completed(await mark(actor, invoiceId))
    const requestId = randomUUID()
    const first = await undo(actor, invoiceId, marked.paymentId, requestId)
    expect(await undo(actor, invoiceId, marked.paymentId, requestId, new Date(now.getTime() + 700_000))).toEqual(first)
    expect(await undo(actor, invoiceId, marked.paymentId)).toMatchObject({ status: "failed", error: { code: "payment_already_voided" } })
  })

  it("refuses ordinary payments even with manual method, and payments of another invoice", async () => {
    const { actor, invoiceId, contactId } = await setup()
    const ordinary = completed(await executeCommand(recordPayment, { invoiceId, amount: 10, paidAt: "2026-10-01", method: "manual", note: "markPaid" }, { actor }))
    expect(await undo(actor, invoiceId, ordinary.payment.id)).toMatchObject({ status: "failed", error: { code: "not_mark_paid_payment" } })
    const marked = completed(await mark(actor, invoiceId))
    const other = completed(await executeCommand(createInvoiceDraft, { contactId, dueDate: "2099-01-01", items: [{ description: "Other", quantity: 1, unitPrice: 10 }] }, { actor }))
    expect(await undo(actor, other.id, marked.paymentId)).toMatchObject({ status: "failed", error: { code: "not_mark_paid_payment" } })
    expect(await undo(actor, invoiceId, "missing-payment")).toMatchObject({ status: "failed", error: { code: "not_mark_paid_payment" } })
    expect((await load(invoiceId)).status).toBe("paid")
  })

  it("members can mark paid but cannot undo, in the router and domain", async () => {
    const { org, invoiceId } = await setup()
    const api = caller(org.actors.member)
    const marked = await api.invoices.markPaid({ invoiceId, requestId: randomUUID() })
    await expect(api.invoices.undoMarkPaid({ invoiceId, paymentId: marked.paymentId, requestId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(await undo(org.actors.member, invoiceId, marked.paymentId)).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
    expect((await load(invoiceId)).status).toBe("paid")
  })

  it.each([{ currency: "JPY", total: 1000 }, { currency: "DKK", total: 1000.02 }])("settles exponent precision for $currency", async options => {
    const { actor, invoiceId } = await setup(options)
    const marked = completed(await mark(actor, invoiceId))
    expect(marked.total).toEqual({ amount: options.total.toFixed(2), currency: options.currency })
    expect(completed(await undo(actor, invoiceId, marked.paymentId)).balance.amount).toBe(options.total.toFixed(2))
  })

  it("settles an existing exponent-3 invoice when its balance fits the two-decimal storage", async () => {
    const { actor, invoiceId } = await setup()
    // Current pricing refuses new exponent-3 documents; older invoices can still hold them.
    await prisma.invoice.update({ where: { id: invoiceId }, data: { currency: "KWD", totalGross: 1000.5 } })
    const marked = completed(await mark(actor, invoiceId))
    expect(marked).toMatchObject({ invoiceStatus: "paid", total: { amount: "1000.50", currency: "KWD" }, balance: { amount: "0.00", currency: "KWD" } })
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: marked.paymentId } })
    expect(payment.amount.toFixed(2)).toBe("1000.50")
    expect(payment.currency).toBe("KWD")
    expect(completed(await undo(actor, invoiceId, marked.paymentId))).toMatchObject({ balance: { amount: "1000.50", currency: "KWD" } })
  })

  it.each(["JPY", "ZZZ"])("refuses an unrepresentable or unsupported %s balance without rounding", async currency => {
    const { actor, invoiceId } = await setup()
    await prisma.invoice.update({ where: { id: invoiceId }, data: { currency, totalGross: 1000.5 } })
    expect(await mark(actor, invoiceId)).toMatchObject({ status: "failed", error: { code: "currency_precision_unsupported" } })
    expect(await prisma.payment.count({ where: { invoiceId } })).toBe(0)
  })

  it.each(["draft", "voided", "cancelled"])("refuses %s invoices", async status => {
    const { actor, invoiceId } = await setup({ draft: status === "draft" })
    await prisma.invoice.update({ where: { id: invoiceId }, data: { status } })
    expect(await mark(actor, invoiceId)).toMatchObject({ status: "failed", error: { code: status === "draft" ? "not_issued" : "invoice_not_payable" } })
    expect(await prisma.payment.count({ where: { invoiceId } })).toBe(0)
  })

  it("refuses zero-balance and fully credited invoices", async () => {
    const { actor, invoiceId } = await setup()
    completed(await executeIssuanceCommand(issueCreditNote, { invoiceId, mode: "full", reason: "Cancelled" }, { actor }))
    expect(await mark(actor, invoiceId)).toMatchObject({ status: "failed", error: { code: "already_settled" } })
    await prisma.invoice.update({ where: { id: invoiceId }, data: { status: "sent", totalGross: 0, amountCredited: 0 } })
    expect(await mark(actor, invoiceId)).toMatchObject({ status: "failed", error: { code: "already_settled" } })
  })

  it("isolates invoices, payments and request IDs by organization", async () => {
    const a = await setup()
    const b = await setup()
    const requestId = randomUUID()
    const marked = completed(await mark(a.actor, a.invoiceId, requestId))
    expect(await mark(b.actor, a.invoiceId)).toMatchObject({ status: "failed", error: { tag: "NotFound" } })
    expect(await undo(b.actor, a.invoiceId, marked.paymentId)).toMatchObject({ status: "failed", error: { tag: "NotFound" } })
    expect(await undo(b.actor, b.invoiceId, marked.paymentId)).toMatchObject({ status: "failed", error: { code: "not_mark_paid_payment" } })
    const other = completed(await mark(b.actor, b.invoiceId, requestId))
    expect(other.paymentId).not.toBe(marked.paymentId)
    expect((await load(a.invoiceId)).status).toBe("paid")
  })

  it("invalidates checkout sessions on both settlement and undo", async () => {
    const { actor, invoiceId } = await setup()
    await prisma.orgSettings.update({ where: { organizationId: actor.organizationId }, data: { stripeSecretKeyEnc: encryptSecret("sk_test_paid_moment") } })
    const before = `cs_before_${invoiceId}`
    await prisma.invoice.update({ where: { id: invoiceId }, data: { stripeCheckoutSessionId: before } })
    const marked = completed(await mark(actor, invoiceId))
    await runJobsNow((await prisma.job.findMany({ where: { organizationId: actor.organizationId, type: EXPIRE_CHECKOUT_SESSION_JOB } })).map(job => job.id), now)
    expect(expireCheckout).toHaveBeenCalledWith({ secretKey: "sk_test_paid_moment", sessionId: before })
    const after = `cs_after_${invoiceId}`
    await prisma.invoice.update({ where: { id: invoiceId }, data: { stripeCheckoutSessionId: after } })
    completed(await undo(actor, invoiceId, marked.paymentId))
    await runJobsNow((await prisma.job.findMany({ where: { organizationId: actor.organizationId, type: EXPIRE_CHECKOUT_SESSION_JOB } })).map(job => job.id), now)
    expect(expireCheckout).toHaveBeenCalledWith({ secretKey: "sk_test_paid_moment", sessionId: after })
    expect(await prisma.job.count({ where: { organizationId: actor.organizationId, type: EXPIRE_CHECKOUT_SESSION_JOB } })).toBe(2)
  })

  it("does not register shortcuts for agent dispatch and refuses system callers", async () => {
    expect(agentTools.some(tool => tool.commandType === markInvoicePaid.type || tool.commandType === undoInvoiceMarkPaid.type)).toBe(false)
    expect(getCommandDefinition(markInvoicePaid.type)).toBeUndefined()
    expect(getCommandDefinition(undoInvoiceMarkPaid.type)).toBeUndefined()
    const { actor, invoiceId } = await setup()
    expect(await mark({ kind: "system", organizationId: actor.organizationId, reason: "scheduler", label: "Scheduler" }, invoiceId)).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
  })
})
