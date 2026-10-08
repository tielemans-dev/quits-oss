import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { executeIssuanceCommand } from "../../application/issuance"
import { prisma } from "../../lib/db"
import { exportAccounting } from "../../lib/exports/accounting"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { ensureTestMembership } from "../../test-utils/membership"
import { resolveUserActor } from "../user-actor"
import { createContact } from "../commands/contacts"
import { createInvoiceDraft, sendInvoice } from "../commands/invoices"
import { issueCreditNote } from "../commands/credit-notes"
import { recordReceipt, allocateReceipt, changeReceipt, previewReceiptAllocation, previewReceiptChange, receiptBalance } from "../commands/settlements"
import { voidPayment } from "../commands/payments"
import { executeCommand } from "../execute"
import { receiptActionInputSchema, type ReceiptAllocateInput } from "@quits/contracts/payments"
import type { UserActor } from "../actor"

const evidence = { reason: "Bank statement reconciled", evidence: "https://evidence.example.test/statement/1" }
const feeEvidence = { reason: "Processor fee on statement", evidence: "https://evidence.example.test/fees/1" }

describe.skipIf(!hasTestDatabase)("receipt allocation and correction", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })
  async function setup(currency = "DKK") {
    const org = await createTestOrganization({ roles: ["admin", "member"], settings: { currency } })
    cleanups.push(org.cleanup)
    const actor = org.actors.admin
    const created = await executeCommand(createContact, { name: "Receipt customer", email: "receipt@example.test" }, { actor })
    if (created.status !== "completed") throw new Error(JSON.stringify(created))
    const contactId = created.result.id
    async function invoice(total = 1000) {
      const draft = await executeCommand(createInvoiceDraft, { contactId, currency, dueDate: "2099-01-01", taxRate: 25, items: [{ description: "Work", quantity: 1, unitPrice: total / 1.25 }] }, { actor })
      if (draft.status !== "completed") throw new Error(JSON.stringify(draft))
      const sent = await executeIssuanceCommand(sendInvoice, { id: draft.result.id, allowSendWithoutEmail: true }, { actor })
      if (sent.status !== "completed") throw new Error(JSON.stringify(sent))
      return draft.result.id
    }
    async function receipt(netAmount: string, feeAmount = "0") {
      const input = { requestId: randomUUID(), contactId, currency, netAmount, feeAmount, reference: randomUUID(), method: "bank_transfer" as const, paidAt: "2026-01-15", ...evidence, ...(feeAmount !== "0" ? { feeEvidence } : {}) }
      const result = await executeCommand(recordReceipt, input, { actor, clientRequestId: input.requestId })
      if (result.status !== "completed") throw new Error(JSON.stringify(result))
      return { id: result.result.receiptId, input }
    }
    return { org, actor, contactId, invoice, receipt }
  }
  async function plan(actor: UserActor, receiptId: string, invoiceId: string, amount: string) {
    const input: ReceiptAllocateInput = { requestId: randomUUID(), receiptId, allocations: [{ invoiceId, receiptAmount: amount, invoiceAmount: amount }], ...evidence }
    return { ...input, previewToken: (await prisma.$transaction(db => previewReceiptAllocation(db, actor.organizationId, input))).previewToken }
  }
  async function change(actor: UserActor, input: unknown) {
    const parsed = receiptActionInputSchema.parse(input)
    const previewToken = await prisma.$transaction(db => previewReceiptChange(db, actor.organizationId, parsed)).then(p => p.previewToken).catch(() => "invalid")
    return executeCommand(changeReceipt, { ...parsed, previewToken }, { actor })
  }
  const balance = async (id: string) => receiptBalance(prisma, await prisma.settlementReceipt.findUniqueOrThrow({ where: { id } }))
  const load = (id: string) => prisma.invoice.findUniqueOrThrow({ where: { id } })

  it("leaves unexplained shortfalls due and requires fee evidence", async () => {
    const s = await setup(); const invoiceId = await s.invoice(); const receipt = await s.receipt("985")
    expect((await executeCommand(allocateReceipt, await plan(s.actor, receipt.id, invoiceId, "985"), { actor: s.actor })).status).toBe("completed")
    expect((await load(invoiceId)).amountPaid.toFixed(2)).toBe("985.00")
    expect((await load(invoiceId)).paymentStatus).toBe("partially_paid")
    expect(await executeCommand(recordReceipt, { ...receipt.input, requestId: randomUUID(), reference: randomUUID(), feeAmount: "15" }, { actor: s.actor })).toMatchObject({ status: "failed", error: { code: "fee_evidence_required" } })
    expect((await balance(receipt.id)).available.toFixed(2)).toBe("0.00")
  })
  it("settles gross 1000/net 985/fee 15 and exports only settlement events", async () => {
    const s = await setup(); const invoiceId = await s.invoice(); const receipt = await s.receipt("985", "15")
    expect((await executeCommand(allocateReceipt, await plan(s.actor, receipt.id, invoiceId, "1000"), { actor: s.actor })).status).toBe("completed")
    expect((await load(invoiceId)).paymentStatus).toBe("paid")
    const stored = await prisma.settlementReceipt.findUniqueOrThrow({ where: { id: receipt.id } })
    expect([stored.grossAmount.toFixed(2), stored.feeAmount.toFixed(2), stored.netAmount.toFixed(2)]).toEqual(["1000.00", "15.00", "985.00"])
    const events = await prisma.domainEvent.findMany({ where: { organizationId: s.org.organizationId } })
    expect(events.filter(e => e.type === "invoice.issued")).toHaveLength(1)
    expect(events.filter(e => e.type === "payment.recorded")).toHaveLength(0)
    expect(events.find(e => e.type === "settlement.receipt_recorded")).toMatchObject({ actorKind: "user", actorId: s.actor.userId, payload: { feeReason: feeEvidence.reason, feeEvidence: feeEvidence.evidence } })
    const exported = await exportAccounting(s.org.organizationId, { dataset: "settlements", from: "2020-01-01", to: "2099-12-31" })
    expect(exported.csv).toContain("settlement.allocated")
    expect(exported.csv).toContain("settlement.receipt_recorded")
    expect(exported.csv).not.toContain("invoice.issued")
  })
  it("splits receipts and keeps independent invoice and receipt residuals", async () => {
    const s = await setup(); const invoices = [await s.invoice(), await s.invoice()]; const receipt = await s.receipt("1800")
    const input = { requestId: randomUUID(), receiptId: receipt.id, allocations: invoices.map(invoiceId => ({ invoiceId, receiptAmount: "800", invoiceAmount: "800" })), ...evidence }
    const preview = await prisma.$transaction(db => previewReceiptAllocation(db, s.org.organizationId, input))
    expect(preview.availableAfter).toBe("200.00")
    expect(preview.allocations.map(a => a.after)).toEqual(["200.00", "200.00"])
    expect((await executeCommand(allocateReceipt, { ...input, previewToken: preview.previewToken }, { actor: s.actor })).status).toBe("completed")
    expect((await balance(receipt.id)).available.toFixed(2)).toBe("200.00")
  })
  it("serializes consumption, rejects stale previews, and replays commands once", async () => {
    const s = await setup(); const invoices = [await s.invoice(), await s.invoice()]; const receipt = await s.receipt("1000")
    const inputs = await Promise.all(invoices.map(invoiceId => plan(s.actor, receipt.id, invoiceId, "750")))
    const results = await Promise.all(inputs.map(input => executeCommand(allocateReceipt, input, { actor: s.actor, clientRequestId: input.requestId })))
    expect(results.filter(r => r.status === "completed")).toHaveLength(1)
    expect((await balance(receipt.id)).available.toFixed(2)).toBe("250.00")
    const winner = inputs[results.findIndex(r => r.status === "completed")]
    expect((await executeCommand(allocateReceipt, winner, { actor: s.actor, clientRequestId: winner.requestId })).status).toBe("completed")
    expect(await prisma.payment.count({ where: { receiptId: receipt.id } })).toBe(1)
    const stale = await plan(s.actor, receipt.id, invoices[0], "1")
    await executeCommand(allocateReceipt, await plan(s.actor, receipt.id, invoices[1], "1"), { actor: s.actor })
    expect(await executeCommand(allocateReceipt, stale, { actor: s.actor })).toMatchObject({ status: "failed", error: { code: "settlement_preview_changed" } })
  })
  it.each(["reason", "evidence"] as const)(
    "rejects old classification, allocation and refund previews after another person changes %s",
    async (field) => {
      const s = await setup()
      const invoiceId = await s.invoice()
      const receipt = await s.receipt("1000")
      const otherUserId = randomUUID()
      await ensureTestMembership(s.org.organizationId, otherUserId, "admin")
      const otherActor = await resolveUserActor({
        organizationId: s.org.organizationId,
        userId: otherUserId,
      })
      if (!otherActor) throw new Error("Second person was not created")
      const retained = {
        reason: "Retain for order B",
        evidence: "https://evidence.example.test/order-B",
      }
      const classify = (actor: UserActor, decision: typeof retained) =>
        change(actor, {
          requestId: randomUUID(),
          action: "customer_credit",
          receiptId: receipt.id,
          ...decision,
        })
      expect((await classify(otherActor, retained)).status).toBe("completed")
      const proposed = receiptActionInputSchema.parse({
        requestId: randomUUID(),
        action: "customer_credit",
        receiptId: receipt.id,
        reason: "Retain for order A",
        evidence: "https://evidence.example.test/order-A",
      })
      const classification = await prisma.$transaction((db) =>
        previewReceiptChange(db, s.org.organizationId, proposed),
      )
      expect(classification.customerCreditBefore).toEqual(retained)
      expect(classification.customerCreditAfter).toEqual({
        reason: proposed.reason,
        evidence: proposed.evidence,
      })
      const allocation = await plan(s.actor, receipt.id, invoiceId, "100")
      const refundInput = receiptActionInputSchema.parse({
        requestId: randomUUID(),
        action: "refund",
        receiptId: receipt.id,
        amount: "100",
        ...evidence,
      })
      const refund = await prisma.$transaction((db) =>
        previewReceiptChange(db, s.org.organizationId, refundInput),
      )
      const newer = {
        ...retained,
        [field]:
          field === "reason" ? "Retain for order C" : "https://evidence.example.test/order-C",
      }
      expect((await classify(otherActor, newer)).status).toBe("completed")

      const failed = { status: "failed", error: { code: "settlement_preview_changed" } }
      expect(
        await executeCommand(
          changeReceipt,
          { ...proposed, previewToken: classification.previewToken },
          { actor: s.actor },
        ),
      ).toMatchObject(failed)
      expect(await executeCommand(allocateReceipt, allocation, { actor: s.actor })).toMatchObject(
        failed,
      )
      expect(
        await executeCommand(
          changeReceipt,
          { ...refundInput, previewToken: refund.previewToken },
          { actor: s.actor },
        ),
      ).toMatchObject(failed)
      expect(
        await prisma.settlementReceipt.findUniqueOrThrow({ where: { id: receipt.id } }),
      ).toMatchObject({ creditReason: newer.reason, creditEvidence: newer.evidence })
      expect((await balance(receipt.id)).available.toFixed(2)).toBe("1000.00")
      expect((await load(invoiceId)).amountPaid.toFixed(2)).toBe("0.00")
      expect(await prisma.payment.count({ where: { receiptId: receipt.id } })).toBe(0)
      expect(await prisma.settlementRefund.count({ where: { receiptId: receipt.id } })).toBe(0)
      const events = await prisma.domainEvent.findMany({
        where: { organizationId: s.org.organizationId, type: "settlement.changed" },
        orderBy: { sequence: "asc" },
      })
      expect(events).toHaveLength(2)
      expect(
        events.map((event) => ({ actorId: event.actorId, payload: event.payload })),
      ).toMatchObject([
        { actorId: otherActor.userId, payload: retained },
        { actorId: otherActor.userId, payload: newer },
      ])
      expect((await change(s.actor, proposed)).status).toBe("completed")
      expect(
        (await prisma.settlementReceipt.findUniqueOrThrow({ where: { id: receipt.id } }))
          .creditReason,
      ).toBe(proposed.reason)
    },
  )
  it("bounds refunds, keeps overpayments as customer credit, and reverses funds exactly", async () => {
    const s = await setup(); const invoiceId = await s.invoice(); const receipt = await s.receipt("1200")
    const allocated = await executeCommand(allocateReceipt, await plan(s.actor, receipt.id, invoiceId, "1000"), { actor: s.actor })
    if (allocated.status !== "completed") throw new Error(JSON.stringify(allocated))
    const update = (extra: object) => change(s.actor, { requestId: randomUUID(), ...evidence, receiptId: receipt.id, ...extra })
    expect((await update({ action: "customer_credit" })).status).toBe("completed")
    expect(await update({ action: "refund", amount: "201" })).toMatchObject({ status: "failed", error: { code: "receipt_exhausted" } })
    const refund = await update({ action: "refund", amount: "200" })
    if (refund.status !== "completed") throw new Error(JSON.stringify(refund))
    expect((await balance(receipt.id)).available.toFixed(2)).toBe("0.00")
    expect(await update({ action: "reverse_receipt" })).toMatchObject({ status: "failed", error: { code: "receipt_in_use" } })
    const paymentId = allocated.result.paymentIds[0]
    expect(await executeCommand(voidPayment, { paymentId, reason: "Wrong allocation" }, { actor: s.actor })).toMatchObject({ status: "failed", error: { code: "receipt_allocation_requires_reversal" } })
    expect((await change(s.actor, { requestId: randomUUID(), action: "reverse_allocation", paymentId, ...evidence })).status).toBe("completed")
    expect((await load(invoiceId)).amountPaid.toFixed(2)).toBe("0.00")
    expect((await prisma.settlementReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).creditReason).toBeNull()
    expect((await change(s.actor, { requestId: randomUUID(), action: "reverse_refund", refundId: refund.result.targetId, ...evidence })).status).toBe("completed")
    expect((await balance(receipt.id)).available.toFixed(2)).toBe("1200.00")
    expect((await update({ action: "reverse_receipt" })).status).toBe("completed")
    expect((await balance(receipt.id)).available.toFixed(2)).toBe("0.00")
  })
  it("requires releasing allocations before crediting paid money", async () => {
    const s = await setup(); const invoiceId = await s.invoice(); const receipt = await s.receipt("1000")
    const allocated = await executeCommand(allocateReceipt, await plan(s.actor, receipt.id, invoiceId, "1000"), { actor: s.actor })
    if (allocated.status !== "completed") throw new Error(JSON.stringify(allocated))
    const credit = () => executeIssuanceCommand(issueCreditNote, { invoiceId, mode: "full", reason: "Cancelled order" }, { actor: s.actor })
    expect(await credit()).toMatchObject({ status: "failed", error: { code: "receipt_allocations_pending" } })
    await change(s.actor, { requestId: randomUUID(), action: "reverse_allocation", paymentId: allocated.result.paymentIds[0], ...evidence })
    expect((await credit()).status).toBe("completed")
    expect((await load(invoiceId)).status).toBe("credited")
    expect((await balance(receipt.id)).available.toFixed(2)).toBe("1000.00")
  })
  it("rejects tax adjustments, missing evidence, duplicate receipts, and cross-tenant access", async () => {
    const s = await setup(); const invoiceId = await s.invoice(); const receipt = await s.receipt("1000")
    for (const action of ["discount", "writeoff"] as const) expect(await change(s.actor, { requestId: randomUUID(), action, invoiceId, amount: "15", ...evidence })).toMatchObject({ status: "failed", error: { code: "accountant_review_required" } })
    expect(await executeCommand(recordReceipt, { ...receipt.input, requestId: randomUUID() }, { actor: s.actor })).toMatchObject({ status: "failed", error: { code: "receipt_reference_exists" } })
    expect(await executeCommand(recordReceipt, { ...receipt.input, evidence: "", reference: randomUUID() }, { actor: s.actor })).toMatchObject({ status: "failed", error: { tag: "ValidationFailed" } })
    const other = await setup(); const input = await plan(s.actor, receipt.id, invoiceId, "1")
    expect(await executeCommand(allocateReceipt, input, { actor: other.actor })).toMatchObject({ status: "failed", error: { code: "receipt_not_found" } })
  })
  it("requires currency conversion evidence and reverses both frozen quantities", async () => {
    const s = await setup(); const invoiceId = await s.invoice()
    const recorded = await executeCommand(recordReceipt, { requestId: randomUUID(), contactId: s.contactId, currency: "EUR", netAmount: "100", feeAmount: "0", paidAt: "2026-01-15", method: "bank_transfer", reference: randomUUID(), ...evidence }, { actor: s.actor })
    if (recorded.status !== "completed") throw new Error(JSON.stringify(recorded))
    const receiptId = recorded.result.receiptId
    const allocation = { invoiceId, receiptAmount: "1", invoiceAmount: "7.45" }
    const input = { requestId: randomUUID(), receiptId, allocations: [allocation], ...evidence }
    expect(await executeCommand(allocateReceipt, { ...input, previewToken: "invalid" }, { actor: s.actor })).toMatchObject({ status: "failed", error: { code: "exchange_evidence_required" } })
    const evidenced = { ...input, allocations: [{ ...allocation, exchangeEvidence: evidence }] }
    const preview = await prisma.$transaction(db => previewReceiptAllocation(db, s.org.organizationId, evidenced))
    const result = await executeCommand(allocateReceipt, { ...evidenced, previewToken: preview.previewToken }, { actor: s.actor })
    if (result.status !== "completed") throw new Error(JSON.stringify(result))
    expect((await load(invoiceId)).amountPaid.toFixed(2)).toBe("7.45")
    expect((await balance(receiptId)).available.toFixed(2)).toBe("99.00")
    expect((await change(s.actor, { requestId: randomUUID(), action: "reverse_allocation", paymentId: result.result.paymentIds[0], ...evidence })).status).toBe("completed")
    expect((await balance(receiptId)).available.toFixed(2)).toBe("100.00")
    expect((await load(invoiceId)).amountPaid.toFixed(2)).toBe("0.00")
  })
  it("refuses agent classification before creating an unusable approval request", async () => {
    const s = await setup(); const receipt = await s.receipt("1000")
    const result = await executeCommand(recordReceipt, { ...receipt.input, reference: randomUUID() }, { actor: {
      kind: "agent", organizationId: s.org.organizationId, agentKeyId: "unregistered-agent", label: "Fixture agent", mode: "approval_required", ownerRoles: s.actor.roles, scopes: ["payment:create"],
    } })
    expect(result).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
    expect(await prisma.approvalRequest.count({ where: { organizationId: s.org.organizationId } })).toBe(0)
  })
  it("conserves fractional allocations and refuses unsupported precision", async () => {
    const s = await setup(); const invoiceId = await s.invoice(1); const receipt = await s.receipt("0.03")
    for (let i = 0; i < 3; i++) expect((await executeCommand(allocateReceipt, await plan(s.actor, receipt.id, invoiceId, "0.01"), { actor: s.actor })).status).toBe("completed")
    expect((await balance(receipt.id)).available.toFixed(2)).toBe("0.00")
    expect((await load(invoiceId)).amountPaid.toFixed(2)).toBe("0.03")
    const invalid = { ...receipt.input, reference: randomUUID(), currency: "JPY", netAmount: "0.01" }
    expect(await executeCommand(recordReceipt, invalid, { actor: s.actor })).toMatchObject({ status: "failed", error: { code: "invalid_settlement_amount" } })
    expect(await executeCommand(recordReceipt, { ...invalid, currency: "KWD", netAmount: "1" }, { actor: s.actor })).toMatchObject({ status: "failed", error: { code: "currency_precision_unsupported" } })
  })
})
