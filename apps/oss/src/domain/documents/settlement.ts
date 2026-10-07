import { Effect } from "effect"
import type { InvoicePaymentProgress } from "@quits/contracts/invoices"
import { Prisma } from "../../../generated/prisma/client"
import { NotFound } from "../errors"
import { Command, Db } from "../services"
import { expireStaleCheckoutSession } from "./checkout-sessions"

type Amount = Prisma.Decimal | number | string

export type InvoiceSettlement = {
  totalGross: Prisma.Decimal
  amountPaid: Prisma.Decimal
  amountCredited: Prisma.Decimal
  /** What the customer still owes after payments and credit notes, never negative. */
  balanceDue: Prisma.Decimal
  paymentStatus: InvoicePaymentProgress
  fullyCredited: boolean
}

export function computeSettlement(input: {
  totalGross: Amount
  amountPaid: Amount
  amountCredited: Amount
}): InvoiceSettlement {
  const totalGross = new Prisma.Decimal(input.totalGross)
  const amountPaid = new Prisma.Decimal(input.amountPaid)
  const amountCredited = new Prisma.Decimal(input.amountCredited)
  const payable = Prisma.Decimal.max(totalGross.minus(amountCredited), 0)
  const balanceDue = Prisma.Decimal.max(payable.minus(amountPaid), 0)
  const fullyCredited = totalGross.greaterThan(0) && amountCredited.greaterThanOrEqualTo(totalGross)

  const paymentStatus: InvoicePaymentProgress =
    payable.greaterThan(0) && balanceDue.isZero()
      ? "paid"
      : amountPaid.greaterThan(0)
        ? "partially_paid"
        : "unpaid"

  return { totalGross, amountPaid, amountCredited, balanceDue, paymentStatus, fullyCredited }
}

/** The lifecycle status an issued invoice should have given its settlement. */
export function settledInvoiceStatus(input: {
  currentStatus: string
  dueDate: Date
  now: Date
  settlement: InvoiceSettlement
}) {
  if (input.currentStatus === "draft") {
    return "draft"
  }
  if (input.settlement.fullyCredited) {
    return "credited"
  }
  if (input.settlement.paymentStatus === "paid") {
    return "paid"
  }
  if (input.currentStatus === "paid" || input.currentStatus === "credited") {
    return input.dueDate < input.now ? "overdue" : "sent"
  }
  return input.currentStatus
}

/**
 * Recomputes an invoice's paid and credited amounts from its payments and credit notes and
 * updates its payment status and lifecycle status. Payment and credit note commands call this
 * after every change so the stored amounts never drift.
 */
export const refreshInvoiceSettlement = (invoiceId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId, now } = yield* Command

    const invoice = yield* Effect.promise(() =>
      db.invoice.findFirst({
        where: { id: invoiceId, organizationId },
        select: {
          id: true,
          status: true,
          dueDate: true,
          totalGross: true,
          amountPaid: true,
          amountCredited: true,
          paidAt: true,
          stripeCheckoutSessionId: true,
        },
      })
    )
    if (!invoice) {
      return yield* new NotFound({ message: "Invoice not found", entity: "invoice", id: invoiceId })
    }

    const [payments, credits, lastPayment] = yield* Effect.promise(() =>
      Promise.all([
        db.payment.aggregate({ where: { invoiceId, voidedAt: null }, _sum: { amount: true } }),
        db.creditNote.aggregate({
          where: { invoiceId, status: "issued" },
          _sum: { totalGross: true },
        }),
        db.payment.findFirst({
          where: { invoiceId, voidedAt: null },
          orderBy: { paidAt: "desc" },
          select: { paidAt: true },
        }),
      ])
    )

    const settlement = computeSettlement({
      totalGross: invoice.totalGross,
      amountPaid: payments._sum.amount ?? 0,
      amountCredited: credits._sum.totalGross ?? 0,
    })
    const status = settledInvoiceStatus({
      currentStatus: invoice.status,
      dueDate: invoice.dueDate,
      now,
      settlement,
    })

    const updated = yield* Effect.promise(() =>
      db.invoice.update({
        where: { id: invoice.id },
        data: {
          amountPaid: settlement.amountPaid,
          amountCredited: settlement.amountCredited,
          paymentStatus: settlement.paymentStatus,
          paidAt: settlement.paymentStatus === "paid" ? (lastPayment?.paidAt ?? now) : null,
          status,
        },
      })
    )

    // An open Checkout session charges the balance due when it was opened; once that changes it
    // would charge the wrong amount, so it is expired.
    if (!computeSettlement(invoice).balanceDue.equals(settlement.balanceDue)) {
      yield* expireStaleCheckoutSession(invoice)
    }

    return { invoice: updated, settlement, previousStatus: invoice.status }
  })
