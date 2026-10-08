import { Effect } from "effect"
import { z } from "zod"
import {
  paymentRecordInputSchema,
  paymentVoidInputSchema,
  type PaymentMethod,
  type PaymentSource,
} from "@quits/contracts/payments"
import { Prisma } from "../../../generated/prisma/client"
import { formatIsoDate, startOfDayInTimeZone } from "../../lib/exports/format"
import { appLogger } from "../../lib/observability"
import { currencyFractionDigits, isExactInCurrency } from "../../lib/payments/stripe-amounts"
import type { Actor } from "../actor"
import { defineCommand } from "../command"
import { lockDocument } from "../documents/locks"
import { expireReplacedCheckoutSession } from "../documents/checkout-sessions"
import { computeSettlement, refreshInvoiceSettlement } from "../documents/settlement"
import { Forbidden, InvalidState, NotFound, ValidationFailed } from "../errors"
import { documentRef } from "../documents/numbering"
import { Command, Db } from "../services"
import { paymentRecordApproval, paymentVoidApproval } from "../approval-contexts"

const paymentsLogger = appLogger.child("payments")

/**
 * A full timestamp may come from a client whose clock or zone runs ahead of the server; "today"
 * somewhere on Earth can be up to 14 hours ahead of UTC, so allow that much slack.
 */
const FUTURE_DATE_TOLERANCE_MS = 14 * 60 * 60 * 1000

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/

function paymentSource(actor: Actor): PaymentSource {
  if (actor.kind === "system") {
    return actor.reason === "stripe_webhook" ? "stripe" : actor.reason === "migration" ? "migration" : "system"
  }
  return actor.kind
}

function toAmount(value: number) {
  return new Prisma.Decimal(value.toFixed(2))
}

/**
 * Loads an invoice for a payment change and locks its row until the command commits, so two
 * payments recorded at the same time cannot both pass the balance check.
 */
const lockInvoice = (invoiceId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    yield* lockDocument("invoice", invoiceId)
    const invoice = yield* Effect.promise(() =>
      db.invoice.findFirst({
        where: { id: invoiceId, organizationId },
        select: {
          id: true,
          number: true,
          status: true,
          currency: true,
          totalGross: true,
          amountPaid: true,
          amountCredited: true,
          paymentStatus: true,
          stripeCheckoutSessionId: true,
        },
      })
    )
    if (!invoice) {
      return yield* new NotFound({ message: "Invoice not found", entity: "invoice", id: invoiceId })
    }
    return invoice
  })

type ApplyPaymentInput = {
  invoiceId: string
  /** Major units. */
  amount: number
  paidAt: Date
  method: PaymentMethod
  reference?: string | null
  note?: string | null
  stripe?: { checkoutSessionId: string; paymentIntentId: string | null; currency: string }
}

/**
 * Records money received against an issued invoice and recomputes its settlement. Manual
 * payments may not exceed the balance due; Stripe payments have already been collected, so they
 * are always recorded and an overpayment is flagged instead of rejected.
 */
const applyPayment = (input: ApplyPaymentInput) =>
  Effect.gen(function* () {
    const db = yield* Db
    const command = yield* Command
    const invoice = yield* lockInvoice(input.invoiceId)

    if (invoice.status === "draft") {
      return yield* new InvalidState({
        message: `Send ${documentRef("invoice", invoice.number)} before recording payments. It is still a draft.`,
        code: "invoice_not_issued",
      })
    }

    const before = computeSettlement(invoice)
    const isStripe = Boolean(input.stripe)

    if (input.stripe && input.stripe.currency.toUpperCase() !== invoice.currency.toUpperCase()) {
      return yield* new InvalidState({
        message: `Stripe charged ${input.stripe.currency.toUpperCase()} but ${documentRef("invoice", invoice.number)} is in ${invoice.currency}`,
        code: "currency_mismatch",
      })
    }

    if (!isStripe && (before.fullyCredited || invoice.status === "credited")) {
      return yield* new InvalidState({
        message: `The ${documentRef("invoice", invoice.number)} is fully credited and cannot receive payments`,
        code: "invoice_credited",
      })
    }

    const amount = toAmount(input.amount)

    if (!isStripe) {
      // Settling the exact remaining balance is always allowed, so an invoice whose total was
      // computed with more precision than its currency has can still be paid off.
      if (!isExactInCurrency(input.amount, invoice.currency) && !amount.equals(before.balanceDue)) {
        const digits = currencyFractionDigits(invoice.currency)
        const message =
          digits === 0
            ? `${invoice.currency} amounts cannot have decimals`
            : `${invoice.currency} amounts can have at most ${digits} decimals`
        return yield* new ValidationFailed({ message, issues: [{ path: "amount", message }] })
      }
      if (before.balanceDue.isZero()) {
        return yield* new InvalidState({
          message: `The ${documentRef("invoice", invoice.number)} is already paid`,
          code: "invoice_already_paid",
        })
      }
      if (amount.greaterThan(before.balanceDue)) {
        return yield* new InvalidState({
          message: `Payment of ${amount.toFixed(2)} ${invoice.currency} exceeds the balance due of ${before.balanceDue.toFixed(2)} ${invoice.currency}`,
          code: "overpayment",
        })
      }
    }

    const overpaidBy = Prisma.Decimal.max(amount.minus(before.balanceDue), 0)
    if (overpaidBy.greaterThan(0)) {
      paymentsLogger.warn("payment.overpaid", {
        organizationId: command.organizationId,
        invoiceId: invoice.id,
        overpaidBy: overpaidBy.toFixed(2),
      })
    }

    const payment = yield* Effect.promise(() =>
      db.payment.create({
        data: {
          organizationId: command.organizationId,
          invoiceId: invoice.id,
          amount,
          currency: invoice.currency,
          paidAt: input.paidAt,
          method: input.method,
          reference: input.reference || null,
          note: input.note || null,
          source: paymentSource(command.actor),
          stripeCheckoutSessionId: input.stripe?.checkoutSessionId ?? null,
          stripePaymentIntentId: input.stripe?.paymentIntentId ?? null,
        },
      })
    )

    if (input.stripe) {
      yield* expireReplacedCheckoutSession(invoice, input.stripe.checkoutSessionId)
      yield* Effect.promise(() =>
        db.invoice.update({
          where: { id: invoice.id },
          data: {
            stripeCheckoutSessionId: input.stripe?.checkoutSessionId,
            stripePaymentIntentId: input.stripe?.paymentIntentId ?? null,
            paymentFailureReason: null,
          },
        })
      )
    }

    const refreshed = yield* refreshInvoiceSettlement(invoice.id)

    command.emit({
      aggregateType: "invoice",
      aggregateId: invoice.id,
      type: "payment.recorded",
      payload: {
        paymentId: payment.id,
        number: invoice.number,
        amount: amount.toFixed(2),
        currency: invoice.currency,
        method: input.method,
        balanceDue: refreshed.settlement.balanceDue.toFixed(2),
        paymentStatus: refreshed.settlement.paymentStatus,
        ...(overpaidBy.greaterThan(0) ? { overpaidBy: overpaidBy.toFixed(2) } : {}),
      },
    })

    if (before.paymentStatus !== "paid" && refreshed.settlement.paymentStatus === "paid") {
      command.emit({
        aggregateType: "invoice",
        aggregateId: invoice.id,
        type: "invoice.paid",
        payload: {
          number: invoice.number,
          amountPaid: refreshed.settlement.amountPaid.toFixed(2),
          currency: invoice.currency,
        },
      })
    }

    return { payment, invoice: refreshed.invoice, balanceDue: refreshed.settlement.balanceDue }
  })

const futurePaymentDate = () =>
  new ValidationFailed({
    message: "The payment date cannot be in the future",
    issues: [{ path: "paidAt", message: "The payment date cannot be in the future" }],
  })

/**
 * A calendar date (`YYYY-MM-DD`) is the day the money arrived in the organization's time zone,
 * so it is stored as the instant that day starts there. Accounting exports group payments by the
 * same time zone, which keeps an October 1 payment in October. Full timestamps are kept as is.
 */
export const parsePaidAt = (value: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId, now } = yield* Command
    if (CALENDAR_DATE.test(value)) {
      const settings = yield* Effect.promise(() =>
        db.orgSettings.findUnique({ where: { organizationId }, select: { timezone: true } })
      )
      const timeZone = settings?.timezone ?? "UTC"
      if (value > formatIsoDate(now, timeZone)) {
        return yield* futurePaymentDate()
      }
      return startOfDayInTimeZone(value, timeZone)
    }

    const paidAt = new Date(value)
    if (paidAt.getTime() > now.getTime() + FUTURE_DATE_TOLERANCE_MS) {
      return yield* futurePaymentDate()
    }
    return paidAt
  })

export const recordPayment = defineCommand({
  type: "payment.record",
  permission: "payment:create",
  outwardFacing: true,
  input: paymentRecordInputSchema,
  summarize: (input) =>
    `Record a ${input.amount.toFixed(2)} ${input.method.replaceAll("_", " ")} payment on invoice ${input.invoiceId}`,
  approvalContext: (input) => paymentRecordApproval(input),
  handle: (input) =>
    Effect.gen(function* () {
      const paidAt = yield* parsePaidAt(input.paidAt)
      return yield* applyPayment({
        invoiceId: input.invoiceId,
        amount: input.amount,
        paidAt,
        method: input.method,
        reference: input.reference,
        note: input.note,
      })
    }),
})

export const stripeCheckoutPaymentInputSchema = z.object({
  invoiceId: z.string().min(1),
  checkoutSessionId: z.string().min(1),
  paymentIntentId: z.string().min(1).nullable(),
  /** Major units converted from the session's `amount_total`. */
  amount: z.number().positive(),
  /** The currency Stripe charged; it must match the invoice currency. */
  currency: z.string().min(1),
  paidAt: z.string().min(1),
})

/**
 * Records a completed Stripe Checkout session. Only the Stripe webhook runs this. Redelivered
 * webhooks are no-ops because a checkout session can back at most one payment.
 */
export const recordStripeCheckoutPayment = defineCommand({
  type: "payment.record_stripe_checkout",
  permission: "payment:create",
  outwardFacing: false,
  input: stripeCheckoutPaymentInputSchema,
  summarize: (input) => `Record Stripe checkout ${input.checkoutSessionId} on invoice ${input.invoiceId}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const { actor, organizationId } = yield* Command
      if (actor.kind !== "system" || actor.reason !== "stripe_webhook") {
        return yield* new Forbidden({ message: "Only Stripe webhooks can record Stripe checkout payments" })
      }

      const existing = yield* Effect.promise(() =>
        db.payment.findUnique({ where: { stripeCheckoutSessionId: input.checkoutSessionId } })
      )
      if (existing) {
        return { payment: existing, alreadyApplied: true }
      }

      // Lock before re-checking so concurrent redeliveries serialize on the invoice row.
      yield* lockInvoice(input.invoiceId)
      const recorded = yield* Effect.promise(() =>
        db.payment.findUnique({ where: { stripeCheckoutSessionId: input.checkoutSessionId } })
      )
      if (recorded) {
        return { payment: recorded, alreadyApplied: true }
      }

      const applied = yield* applyPayment({
        invoiceId: input.invoiceId,
        amount: input.amount,
        paidAt: new Date(input.paidAt),
        method: "stripe",
        reference: input.paymentIntentId ?? input.checkoutSessionId,
        stripe: {
          checkoutSessionId: input.checkoutSessionId,
          paymentIntentId: input.paymentIntentId,
          currency: input.currency,
        },
      })
      paymentsLogger.info("payment.stripe_recorded", {
        organizationId,
        invoiceId: input.invoiceId,
        paymentId: applied.payment.id,
      })
      return { payment: applied.payment, alreadyApplied: false }
    }),
})

export const stripeCheckoutFailureInputSchema = z.object({
  invoiceId: z.string().min(1),
  checkoutSessionId: z.string().min(1),
  paymentIntentId: z.string().min(1).nullable(),
  reason: z.string().min(1).max(500),
})

/**
 * Records that an asynchronous Stripe payment (a bank debit, for example) failed after checkout.
 * No money is recorded; the reason is kept on the invoice so the failure is visible.
 */
export const recordStripeCheckoutFailure = defineCommand({
  type: "payment.record_stripe_checkout_failure",
  permission: "payment:create",
  outwardFacing: false,
  input: stripeCheckoutFailureInputSchema,
  summarize: (input) => `Record failed Stripe checkout ${input.checkoutSessionId} on invoice ${input.invoiceId}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      if (command.actor.kind !== "system" || command.actor.reason !== "stripe_webhook") {
        return yield* new Forbidden({ message: "Only Stripe webhooks can record Stripe checkout failures" })
      }

      const invoice = yield* lockInvoice(input.invoiceId)
      // A failure changes no balance. When the customer has since opened another checkout, the
      // invoice keeps tracking that one: the failure of the older session is only recorded in the
      // activity log, and the session in progress is neither replaced nor expired.
      const current =
        invoice.stripeCheckoutSessionId === null || invoice.stripeCheckoutSessionId === input.checkoutSessionId
      const updated = current
        ? yield* Effect.promise(() =>
            db.invoice.update({
              where: { id: invoice.id },
              data: {
                stripeCheckoutSessionId: input.checkoutSessionId,
                stripePaymentIntentId: input.paymentIntentId,
                paymentFailureReason: input.reason,
              },
            })
          )
        : yield* Effect.promise(() => db.invoice.findUniqueOrThrow({ where: { id: invoice.id } }))

      command.emit({
        aggregateType: "invoice",
        aggregateId: invoice.id,
        type: "payment.failed",
        payload: {
          number: invoice.number,
          method: "stripe",
          checkoutSessionId: input.checkoutSessionId,
          reason: input.reason,
          ...(current ? {} : { supersededBy: invoice.stripeCheckoutSessionId }),
        },
      })
      paymentsLogger.warn("payment.stripe_failed", {
        organizationId: command.organizationId,
        invoiceId: invoice.id,
        checkoutSessionId: input.checkoutSessionId,
        current,
      })
      return { invoice: updated }
    }),
})

export const voidPayment = defineCommand({
  type: "payment.void",
  permission: "payment:void",
  outwardFacing: true,
  input: paymentVoidInputSchema,
  summarize: (input) => `Void payment ${input.paymentId}: ${input.reason}`,
  approvalContext: (input) => paymentVoidApproval(input),
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const found = yield* Effect.promise(() =>
        db.payment.findFirst({
          where: { id: input.paymentId, organizationId: command.organizationId },
          select: { id: true, invoiceId: true },
        })
      )
      if (!found) {
        return yield* new NotFound({ message: "Payment not found", entity: "payment", id: input.paymentId })
      }

      const invoice = yield* lockInvoice(found.invoiceId)
      const payment = yield* Effect.promise(() =>
        db.payment.findUniqueOrThrow({ where: { id: found.id } })
      )
      if (payment.receiptId) {
        return yield* new InvalidState({ message: "Reverse this receipt allocation with linked evidence", code: "receipt_allocation_requires_reversal" })
      }
      if (payment.voidedAt) {
        return yield* new InvalidState({
          message: "This payment is already voided",
          code: "payment_already_voided",
        })
      }

      const voided = yield* Effect.promise(() =>
        db.payment.update({
          where: { id: payment.id },
          data: { voidedAt: command.now, voidReason: input.reason },
        })
      )
      const refreshed = yield* refreshInvoiceSettlement(invoice.id)

      command.emit({
        aggregateType: "invoice",
        aggregateId: invoice.id,
        type: "payment.voided",
        payload: {
          paymentId: payment.id,
          number: invoice.number,
          amount: payment.amount.toFixed(2),
          currency: payment.currency,
          reason: input.reason,
          balanceDue: refreshed.settlement.balanceDue.toFixed(2),
          paymentStatus: refreshed.settlement.paymentStatus,
          status: refreshed.invoice.status,
        },
      })

      return { payment: voided, invoice: refreshed.invoice, balanceDue: refreshed.settlement.balanceDue }
    }),
})

/** Owned by the payments feature. */
export const paymentCommands = [
  recordPayment,
  recordStripeCheckoutPayment,
  recordStripeCheckoutFailure,
  voidPayment,
] as const
