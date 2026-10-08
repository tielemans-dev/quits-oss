import { z } from "zod"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { receiptRecordInputSchema, receiptAllocateInputSchema, receiptActionInputSchema, type ReceiptAllocateInput, type ReceiptActionInput } from "@quits/contracts/payments"
import { getCurrencyExponent } from "@quits/shared/currency"
import { Prisma, type SettlementReceipt } from "../../../generated/prisma/client"
import { actorKey } from "../actor"
import { defineCommand } from "../command"
import { computeSettlement, refreshInvoiceSettlement } from "../documents/settlement"
import { Forbidden, InvalidState, NotFound } from "../errors"
import { Command, Db } from "../services"
import { parsePaidAt } from "./payments"

class SettlementRefusal extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
const refuse = (code: string, message: string): never => { throw new SettlementRefusal(code, message) }
const run = <T>(f: () => Promise<T>) => Effect.tryPromise({ try: f, catch: error => {
  if (error instanceof SettlementRefusal) return new InvalidState({ code: error.code, message: error.message })
  throw error
} })

/** Reject fractions rather than silently changing evidence. All arithmetic stays decimal. */
export function settlementAmount(value: string, currency: string, allowZero = false) {
  const exponent = getCurrencyExponent(currency)
  if (exponent === undefined || exponent > 2) return refuse("currency_precision_unsupported", `Unsupported currency ${currency}`)
  const amount = new Prisma.Decimal(value)
  if (amount.decimalPlaces() > exponent || amount.isNegative() || (!allowZero && amount.isZero()) || amount.greaterThan("9999999999.99")) {
    return refuse("invalid_settlement_amount", `Enter an exact ${currency} amount${allowZero ? "" : " greater than zero"}`)
  }
  return amount
}

export async function receiptBalance(db: Prisma.TransactionClient, receipt: SettlementReceipt) {
  const [payments, refunds] = await Promise.all([
    db.payment.aggregate({ where: { receiptId: receipt.id, voidedAt: null }, _sum: { receiptAmount: true } }),
    db.settlementRefund.aggregate({ where: { receiptId: receipt.id, reversedAt: null }, _sum: { amount: true } }),
  ])
  const allocated = payments._sum.receiptAmount ?? new Prisma.Decimal(0)
  const refunded = refunds._sum.amount ?? new Prisma.Decimal(0)
  return { allocated, refunded, available: receipt.reversedAt ? new Prisma.Decimal(0) : receipt.grossAmount.minus(allocated).minus(refunded) }
}

async function loadReceipt(db: Prisma.TransactionClient, organizationId: string, id: string) {
  // executeCommand also holds the organization lock. Retain a receipt lock for independent callers.
  await db.$queryRaw`SELECT id FROM settlement_receipt WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`
  const receipt = await db.settlementReceipt.findFirst({ where: { id, organizationId } })
  if (!receipt) return refuse("receipt_not_found", "Receipt not found")
  if (receipt.reversedAt) return refuse("receipt_reversed", "This receipt was reversed")
  return receipt
}

/** Shared by preview and commit. Invoice rows are locked in stable order by the command's org lock. */
export async function previewReceiptAllocation(db: Prisma.TransactionClient, organizationId: string, input: ReceiptAllocateInput) {
  const receipt = await loadReceipt(db, organizationId, input.receiptId)
  if (new Set(input.allocations.map(a => a.invoiceId)).size !== input.allocations.length) return refuse("duplicate_invoice", "Select each invoice only once")
  const balance = await receiptBalance(db, receipt)
  const allocations = []
  for (const allocation of [...input.allocations].sort((a, b) => a.invoiceId.localeCompare(b.invoiceId))) {
    const invoice = await db.invoice.findFirst({ where: { id: allocation.invoiceId, organizationId } })
    if (!invoice) return refuse("invoice_not_found", "Invoice not found")
    if (invoice.contactId !== receipt.contactId) return refuse("customer_mismatch", "Receipt and invoice must belong to the same customer")
    if (invoice.status === "draft" || invoice.status === "credited" || invoice.number === null) return refuse("invoice_not_payable", "Select an issued invoice with debt remaining")
    const receiptAmount = settlementAmount(allocation.receiptAmount, receipt.currency)
    const invoiceAmount = settlementAmount(allocation.invoiceAmount, invoice.currency)
    if (receipt.currency === invoice.currency && !receiptAmount.equals(invoiceAmount)) return refuse("same_currency_difference", "Same-currency allocation amounts must match; a shortfall remains due")
    if (receipt.currency !== invoice.currency && !allocation.exchangeEvidence) return refuse("exchange_evidence_required", "Explain the currency conversion and link its evidence")
    const before = computeSettlement(invoice).balanceDue
    if (invoiceAmount.greaterThan(before)) return refuse("overpayment", "Allocation exceeds the invoice balance")
    allocations.push({ invoiceId: invoice.id, number: invoice.number, currency: invoice.currency, invoiceTotal: invoice.totalGross.toFixed(2), receiptAmount: receiptAmount.toFixed(2), invoiceAmount: invoiceAmount.toFixed(2), before: before.toFixed(2), after: before.minus(invoiceAmount).toFixed(2), exchangeEvidence: allocation.exchangeEvidence ?? null })
  }
  const consumed = allocations.reduce((sum, a) => sum.plus(a.receiptAmount), new Prisma.Decimal(0))
  if (consumed.greaterThan(balance.available)) return refuse("receipt_exhausted", "Allocation exceeds the receipt's available amount")
  const plan = { receiptId: receipt.id, currency: receipt.currency, grossAmount: receipt.grossAmount.toFixed(2), feeAmount: receipt.feeAmount.toFixed(2), netAmount: receipt.netAmount.toFixed(2), availableBefore: balance.available.toFixed(2), availableAfter: balance.available.minus(consumed).toFixed(2), allocations }
  return { ...plan, previewToken: createHash("sha256").update(JSON.stringify({ plan, reason: input.reason, evidence: input.evidence })).digest("hex") }
}

const refuseAgentClassification = () => Effect.fail(new Forbidden({ message: "Receipt classification requires a person" }))

export const recordReceipt = defineCommand({
  type: "settlement.record_receipt", permission: "payment:create", outwardFacing: true,
  requiresApproval: refuseAgentClassification,
  input: receiptRecordInputSchema,
  summarize: input => `Record receipt ${input.reference}: ${input.netAmount} ${input.currency} net`,
  handle: input => Effect.gen(function* () {
    const db = yield* Db
    const command = yield* Command
    if (command.actor.kind !== "user") return yield* new Forbidden({ message: "Receipt classification requires a person" })
    const paidAt = yield* parsePaidAt(input.paidAt)
    const net = yield* run(async () => settlementAmount(input.netAmount, input.currency, true))
    const fee = yield* run(async () => settlementAmount(input.feeAmount, input.currency, true))
    const gross = yield* run(async () => settlementAmount(net.plus(fee).toFixed(2), input.currency))
    if (fee.greaterThan(0) && !input.feeEvidence) return yield* new InvalidState({ code: "fee_evidence_required", message: "Explain the processor fee and link its evidence" })
    const contact = yield* Effect.promise(() => db.contact.findFirst({ where: { id: input.contactId, organizationId: command.organizationId } }))
    if (!contact) return yield* new NotFound({ entity: "contact", id: input.contactId, message: "Customer not found" })
    const duplicate = yield* Effect.promise(() => db.settlementReceipt.findUnique({ where: { organizationId_reference: { organizationId: command.organizationId, reference: input.reference } } }))
    if (duplicate) return yield* new InvalidState({ code: "receipt_reference_exists", message: "This receipt reference is already recorded" })
    const receipt = yield* Effect.promise(() => db.settlementReceipt.create({ data: {
      organizationId: command.organizationId, contactId: contact.id, currency: input.currency,
      grossAmount: gross, netAmount: net, feeAmount: fee, paidAt, method: input.method, reference: input.reference,
      reason: input.reason, evidence: input.evidence, feeReason: input.feeEvidence?.reason, feeEvidence: input.feeEvidence?.evidence,
      actorKey: actorKey(command.actor), commandId: command.commandId,
    } }))
    command.emit({ aggregateType: "settlement_receipt", aggregateId: receipt.id, type: "settlement.receipt_recorded", payload: {
      receiptId: receipt.id, contactId: receipt.contactId, currency: receipt.currency, grossAmount: gross.toFixed(2), netAmount: net.toFixed(2), feeAmount: fee.toFixed(2), paidAt: paidAt.toISOString(), method: receipt.method, reference: receipt.reference,
      reason: input.reason, evidence: input.evidence, feeReason: input.feeEvidence?.reason ?? null, feeEvidence: input.feeEvidence?.evidence ?? null,
    } })
    return { receiptId: receipt.id, grossAmount: gross.toFixed(2), feeAmount: fee.toFixed(2), netAmount: net.toFixed(2) }
  }),
})

export const allocateReceipt = defineCommand({
  type: "settlement.allocate", permission: "payment:create", outwardFacing: true,
  requiresApproval: refuseAgentClassification,
  input: receiptAllocateInputSchema.extend({ previewToken: receiptRecordInputSchema.shape.requestId.max(64) }),
  summarize: input => `Allocate receipt ${input.receiptId} to ${input.allocations.length} invoices`,
  handle: input => Effect.gen(function* () {
    const db = yield* Db
    const command = yield* Command
    if (command.actor.kind !== "user") return yield* new Forbidden({ message: "Receipt classification requires a person" })
    const plan = yield* run(() => previewReceiptAllocation(db, command.organizationId, input))
    if (input.previewToken !== plan.previewToken) return yield* new InvalidState({ code: "settlement_preview_changed", message: "Balances changed. Review a new preview before committing." })
    const receipt = yield* Effect.promise(() => db.settlementReceipt.findUniqueOrThrow({ where: { id: input.receiptId } }))
    const paymentIds = []
    for (const allocation of plan.allocations) {
      const payment = yield* Effect.promise(() => db.payment.create({ data: {
        organizationId: command.organizationId, invoiceId: allocation.invoiceId, amount: allocation.invoiceAmount, currency: allocation.currency,
        paidAt: receipt.paidAt, method: receipt.method, reference: receipt.reference, source: "user", receiptId: receipt.id, receiptAmount: allocation.receiptAmount,
        allocationReason: input.reason, allocationEvidence: input.evidence, exchangeReason: allocation.exchangeEvidence?.reason, exchangeEvidence: allocation.exchangeEvidence?.evidence,
      } }))
      paymentIds.push(payment.id)
      const refreshed = yield* refreshInvoiceSettlement(payment.invoiceId)
      command.emit({ aggregateType: "invoice", aggregateId: payment.invoiceId, type: "settlement.allocated", payload: {
        receiptId: receipt.id, paymentId: payment.id, invoiceId: payment.invoiceId, receiptCurrency: receipt.currency, receiptAmount: allocation.receiptAmount, invoiceCurrency: allocation.currency, invoiceAmount: allocation.invoiceAmount,
        balanceDue: allocation.after, reason: input.reason, evidence: input.evidence, exchangeReason: allocation.exchangeEvidence?.reason ?? null, exchangeEvidence: allocation.exchangeEvidence?.evidence ?? null,
      } })
      if (refreshed.settlement.paymentStatus === "paid") {
        command.emit({ aggregateType: "invoice", aggregateId: payment.invoiceId, type: "invoice.paid", payload: {
          number: allocation.number, amountPaid: refreshed.settlement.amountPaid.toFixed(2), currency: allocation.currency,
        } })
      }
    }
    return { ...plan, paymentIds }
  }),
})

/** Refunds and corrections preview both sides and refuse stale balances at commit. */
export async function previewReceiptChange(db: Prisma.TransactionClient, organizationId: string, input: ReceiptActionInput) {
  if (input.action === "writeoff" || input.action === "discount") return refuse("accountant_review_required", "Writeoffs and discounts require an approved accounting policy and remain disabled")
  const payment = input.action === "reverse_allocation" ? await db.payment.findFirst({ where: { id: input.paymentId, organizationId } }) : null
  const refund = input.action === "reverse_refund" ? await db.settlementRefund.findFirst({ where: { id: input.refundId, receipt: { organizationId } } }) : null
  const receiptId = "receiptId" in input ? input.receiptId : payment?.receiptId ?? refund?.receiptId
  if (!receiptId) return refuse("settlement_not_found", "Receipt allocation or refund not found")
  const receipt = await loadReceipt(db, organizationId, receiptId)
  const balance = await receiptBalance(db, receipt)
  let after = balance.available
  let invoice: { id: string; currency: string; before: string; after: string } | null = null
  if (input.action === "refund") {
    const amount = settlementAmount(input.amount, receipt.currency)
    if (amount.greaterThan(balance.available)) return refuse("receipt_exhausted", "Refund exceeds available funds. Reverse allocations before refunding applied money.")
    after = after.minus(amount)
  } else if (input.action === "reverse_allocation" && payment) {
    if (payment.voidedAt) return refuse("allocation_reversed", "Allocation already reversed")
    const row = await db.invoice.findUniqueOrThrow({ where: { id: payment.invoiceId } })
    invoice = { id: row.id, currency: row.currency, before: computeSettlement(row).balanceDue.toFixed(2), after: computeSettlement({ ...row, amountPaid: row.amountPaid.minus(payment.amount) }).balanceDue.toFixed(2) }
    after = after.plus(payment.receiptAmount!)
  } else if (input.action === "reverse_refund" && refund) {
    if (refund.reversedAt) return refuse("refund_reversed", "Refund already reversed")
    after = after.plus(refund.amount)
  } else if (input.action === "reverse_receipt") {
    if (!balance.allocated.isZero() || !balance.refunded.isZero()) return refuse("receipt_in_use", "Reverse all allocations and refunds before reversing the receipt")
    after = new Prisma.Decimal(0)
  } else if (input.action === "customer_credit" && balance.available.isZero()) return refuse("receipt_exhausted", "No available customer credit")
  const plan = { receiptId, currency: receipt.currency, availableBefore: balance.available.toFixed(2), availableAfter: after.toFixed(2), invoice }
  return { ...plan, previewToken: createHash("sha256").update(JSON.stringify({ input, plan })).digest("hex") }
}

const changeOptions = receiptActionInputSchema.options.map(option => option.extend({ previewToken: z.string().min(1).max(64) }))
export const changeReceipt = defineCommand({
  type: "settlement.change", permission: "payment:void", outwardFacing: true,
  requiresApproval: refuseAgentClassification,
  input: z.discriminatedUnion("action", [changeOptions[0]!, ...changeOptions.slice(1)]),
  summarize: input => `${input.action.replaceAll("_", " ")}: ${input.reason}`,
  handle: input => Effect.gen(function* () {
    const db = yield* Db
    const command = yield* Command
    if (command.actor.kind !== "user") return yield* new Forbidden({ message: "Receipt classification requires a person" })
    if (input.action === "writeoff" || input.action === "discount") return yield* new InvalidState({ code: "accountant_review_required", message: "Writeoffs and discounts require an approved accounting policy and remain disabled" })
    const { previewToken, ...change } = input
    const preview = yield* run(() => previewReceiptChange(db, command.organizationId, change))
    if (previewToken !== preview.previewToken) return yield* new InvalidState({ code: "settlement_preview_changed", message: "Balances changed. Review a new preview before committing." })
    const payment = input.action === "reverse_allocation" ? yield* Effect.promise(() => db.payment.findFirst({ where: { id: input.paymentId, organizationId: command.organizationId } })) : null
    const refund = input.action === "reverse_refund" ? yield* Effect.promise(() => db.settlementRefund.findFirst({ where: { id: input.refundId, receipt: { organizationId: command.organizationId } } })) : null
    const receiptId = "receiptId" in input ? input.receiptId : payment?.receiptId ?? refund?.receiptId
    if (!receiptId) return yield* new InvalidState({ code: "settlement_not_found", message: "Receipt allocation or refund not found" })
    const receipt = yield* run(() => loadReceipt(db, command.organizationId, receiptId))
    const balance = yield* Effect.promise(() => receiptBalance(db, receipt))
    let amount = new Prisma.Decimal(0)
    let targetId = receipt.id
    let invoiceId: string | null = null
    let invoiceAmount: string | null = null
    let invoiceCurrency: string | null = null
    if (input.action === "refund") {
      amount = yield* run(async () => settlementAmount(input.amount, receipt.currency))
      if (amount.greaterThan(balance.available)) return yield* new InvalidState({ code: "receipt_exhausted", message: "Refund exceeds available funds. Reverse allocations before refunding applied money." })
      const created = yield* Effect.promise(() => db.settlementRefund.create({ data: { receiptId, amount, reason: input.reason, evidence: input.evidence, actorKey: actorKey(command.actor), commandId: command.commandId } }))
      targetId = created.id
    } else if (input.action === "reverse_allocation" && payment) {
      if (payment.voidedAt) return yield* new InvalidState({ code: "allocation_reversed", message: "Allocation already reversed" })
      amount = payment.receiptAmount!
      targetId = payment.id
      invoiceId = payment.invoiceId
      invoiceAmount = payment.amount.toFixed(2)
      invoiceCurrency = payment.currency
      yield* Effect.promise(() => db.payment.update({ where: { id: payment.id }, data: { voidedAt: command.now, voidReason: input.reason } }))
      yield* refreshInvoiceSettlement(payment.invoiceId)
    } else if (input.action === "reverse_refund" && refund) {
      if (refund.reversedAt) return yield* new InvalidState({ code: "refund_reversed", message: "Refund already reversed" })
      amount = refund.amount
      targetId = refund.id
      yield* Effect.promise(() => db.settlementRefund.update({ where: { id: refund.id }, data: { reversedAt: command.now } }))
    } else if (input.action === "reverse_receipt") {
      if (!balance.allocated.isZero() || !balance.refunded.isZero()) return yield* new InvalidState({ code: "receipt_in_use", message: "Reverse all allocations and refunds before reversing the receipt" })
      amount = receipt.grossAmount
      yield* Effect.promise(() => db.settlementReceipt.update({ where: { id: receipt.id }, data: { reversedAt: command.now } }))
    } else if (input.action === "customer_credit") {
      if (balance.available.isZero()) return yield* new InvalidState({ code: "receipt_exhausted", message: "No available customer credit" })
      amount = balance.available
      yield* Effect.promise(() => db.settlementReceipt.update({ where: { id: receipt.id }, data: { creditReason: input.reason, creditEvidence: input.evidence } }))
    }
    // Restored funds were not covered by the prior residual classification. Keep its event,
    // but require a new evidenced decision for the now larger available balance.
    if (input.action === "reverse_allocation" || input.action === "reverse_refund" || input.action === "reverse_receipt") {
      yield* Effect.promise(() => db.settlementReceipt.update({ where: { id: receipt.id }, data: { creditReason: null, creditEvidence: null } }))
    }
    command.emit({ aggregateType: invoiceId ? "invoice" : "settlement_receipt", aggregateId: invoiceId ?? receipt.id, type: "settlement.changed", payload: {
      action: input.action, receiptId: receipt.id, targetId, currency: receipt.currency, amount: amount.toFixed(2), invoiceId, invoiceAmount, invoiceCurrency,
      reason: input.reason, evidence: input.evidence,
    } })
    return { receiptId: receipt.id, targetId, action: input.action }
  }),
})

export const settlementCommands = [recordReceipt, allocateReceipt, changeReceipt] as const
