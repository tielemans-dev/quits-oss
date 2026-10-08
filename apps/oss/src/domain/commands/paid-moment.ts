import { Effect } from "effect"
import {
  invoiceMarkPaidInputSchema,
  invoiceUndoMarkPaidInputSchema,
  invoicePaidMomentResultSchema,
} from "@quits/contracts/invoices"
import { getCurrencyExponent } from "@quits/shared/currency"
import { Prisma } from "../../../generated/prisma/client"
import { formatIsoDate } from "../../lib/exports/format"
import { defineCommand } from "../command"
import { lockDocument } from "../documents/locks"
import { computeSettlement } from "../documents/settlement"
import { Forbidden, InvalidState, NotFound } from "../errors"
import { eventRegistry } from "../events/registry"
import { Command, Db } from "../services"
import { recordPayment, voidPayment } from "./payments"

const UNDO_WINDOW_MS = 10 * 60 * 1000

const loadInvoice = (invoiceId: string) => Effect.gen(function* () {
  const db = yield* Db
  const command = yield* Command
  if (command.actor.kind !== "user") {
    return yield* new Forbidden({ message: "Only users can mark an invoice paid or undo it" })
  }
  yield* lockDocument("invoice", invoiceId)
  const invoice = yield* Effect.promise(() => db.invoice.findFirst({
    where: { id: invoiceId, organizationId: command.organizationId },
  }))
  if (!invoice) return yield* new NotFound({ message: "Invoice not found", entity: "invoice", id: invoiceId })
  return invoice
})

function resultFor(
  applied: Effect.Effect.Success<ReturnType<typeof recordPayment.handle>>,
  undoUntil: string,
) {
  const { invoice, balanceDue, payment } = applied
  const total = invoice.totalGross
  const paidFraction = total.greaterThan(0)
    ? Prisma.Decimal.min(1, Prisma.Decimal.max(0, total.minus(balanceDue).div(total))).toFixed()
    : "1"
  return invoicePaidMomentResultSchema.parse({
    paymentId: payment.id,
    invoiceStatus: invoice.status,
    balance: { amount: balanceDue.toFixed(2), currency: invoice.currency },
    total: { amount: total.toFixed(2), currency: invoice.currency },
    paidFraction,
    undoUntil,
  })
}

/** User-only conveniences, deliberately absent from the agent/approval command registry. */
export const markInvoicePaid = defineCommand({
  type: "invoice.mark_paid",
  permission: "payment:create",
  outwardFacing: true,
  input: invoiceMarkPaidInputSchema,
  summarize: input => `Mark invoice ${input.invoiceId} paid`,
  handle: input => Effect.gen(function* () {
    const invoice = yield* loadInvoice(input.invoiceId)
    const db = yield* Db
    const command = yield* Command
    if (invoice.status === "draft") {
      return yield* new InvalidState({ code: "not_issued", message: "Issue the invoice before marking it paid" })
    }
    // The current model has no void/cancel lifecycle states. Refuse them explicitly if imported
    // or introduced later, and reject any other state outside the issued lifecycle.
    if (invoice.status === "voided" || invoice.status === "cancelled") {
      return yield* new InvalidState({ code: "invoice_not_payable", message: "A voided or cancelled invoice cannot be marked paid" })
    }
    const { balanceDue } = computeSettlement(invoice)
    if (invoice.status === "paid" || invoice.status === "credited" || balanceDue.isZero()) {
      return yield* new InvalidState({ code: "already_settled", message: "The invoice is already settled" })
    }
    if (!["sent", "viewed", "overdue"].includes(invoice.status)) {
      return yield* new InvalidState({ code: "invoice_not_payable", message: "The invoice cannot receive a payment in its current state" })
    }
    const exponent = getCurrencyExponent(invoice.currency)
    if (exponent === undefined || balanceDue.decimalPlaces() > Math.min(exponent, 2)) {
      return yield* new InvalidState({ code: "currency_precision_unsupported", message: `The remaining balance cannot be recorded exactly in ${invoice.currency}` })
    }
    const settings = yield* Effect.promise(() => db.orgSettings.findUnique({
      where: { organizationId: command.organizationId }, select: { timezone: true },
    }))
    // Run the existing handler in this command's transaction, with its events and outbox.
    const applied = yield* recordPayment.handle({
      invoiceId: invoice.id,
      amount: balanceDue.toNumber(),
      paidAt: formatIsoDate(command.now, settings?.timezone ?? "UTC"),
      method: "manual",
    })
    const undoUntil = new Date(command.now.getTime() + UNDO_WINDOW_MS).toISOString()
    command.emit({
      aggregateType: "invoice", aggregateId: invoice.id, type: "invoice.marked_paid",
      payload: { paymentId: applied.payment.id, undoUntil },
    })
    return resultFor(applied, undoUntil)
  }),
})

export const undoInvoiceMarkPaid = defineCommand({
  type: "invoice.undo_mark_paid",
  permission: "payment:void",
  outwardFacing: true,
  input: invoiceUndoMarkPaidInputSchema,
  summarize: input => `Undo mark paid for invoice ${input.invoiceId}`,
  handle: input => Effect.gen(function* () {
    yield* loadInvoice(input.invoiceId)
    const db = yield* Db
    const command = yield* Command
    const payment = yield* Effect.promise(() => db.payment.findFirst({
      where: { id: input.paymentId, invoiceId: input.invoiceId, organizationId: command.organizationId },
    }))
    if (!payment) {
      return yield* new InvalidState({ code: "not_mark_paid_payment", message: "This is not a mark-paid payment of this invoice" })
    }
    if (payment.receiptId) {
      return yield* new InvalidState({ code: "receipt_allocation_requires_reversal", message: "Reverse this receipt allocation with linked evidence" })
    }
    // Only this command emits the provenance event; mutable notes or method alone cannot prove it.
    const marked = yield* Effect.promise(() => db.domainEvent.findFirst({
      where: {
        organizationId: command.organizationId, aggregateId: input.invoiceId,
        type: "invoice.marked_paid", payload: { path: ["paymentId"], equals: payment.id },
      },
    }))
    if (!marked) {
      return yield* new InvalidState({ code: "not_mark_paid_payment", message: "This payment was not created by mark paid" })
    }
    if (payment.voidedAt) {
      return yield* new InvalidState({ code: "payment_already_voided", message: "This payment is already voided" })
    }
    const { undoUntil } = eventRegistry["invoice.marked_paid"].schema.parse(marked.payload)
    if (command.now.getTime() >= new Date(undoUntil).getTime()) {
      return yield* new InvalidState({ code: "undo_expired", message: "The undo window has expired. Void the payment from the payments panel." })
    }
    const applied = yield* voidPayment.handle({ paymentId: payment.id, reason: "Fortrudt" })
    return resultFor(applied, undoUntil)
  }),
})
