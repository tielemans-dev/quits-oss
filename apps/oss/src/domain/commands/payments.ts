import { Effect } from "effect"
import { z } from "zod"
import {
  paymentRecordInputSchema,
  paymentVoidInputSchema,
  type PaymentMethod,
  type PaymentSource,
} from "@yaip/contracts/payments"
import { Prisma } from "../../../generated/prisma/client"
import { appLogger } from "../../lib/observability"
import type { Actor } from "../actor"
import { defineCommand } from "../command"
import { computeSettlement, refreshInvoiceSettlement } from "../documents/settlement"
import { Forbidden, InvalidState, NotFound, ValidationFailed } from "../errors"
import { Command, Db } from "../services"

const paymentsLogger = appLogger.child("payments")

/**
 * Payment dates are calendar dates entered in the organization's time zone. A date that is
 * "today" somewhere on Earth can be up to 14 hours ahead of UTC, so allow that much slack.
 */
const FUTURE_DATE_TOLERANCE_MS = 14 * 60 * 60 * 1000

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
    yield* Effect.promise(
      () => db.$queryRaw`SELECT "id" FROM "invoice" WHERE "id" = ${invoiceId} AND "organizationId" = ${organizationId} FOR UPDATE`
    )
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
  /** Major units. Omit to pay the full balance due. */
  amount?: number
  paidAt: Date
  method: PaymentMethod
  reference?: string | null
  note?: string | null
  stripe?: { checkoutSessionId: string; paymentIntentId: string | null; currency: string | null }
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
        message: `Invoice ${invoice.number} is a draft. Send it before recording payments.`,
        code: "invoice_not_issued",
      })
    }

    const before = computeSettlement(invoice)
    const isStripe = Boolean(input.stripe)

    if (input.stripe?.currency && input.stripe.currency.toUpperCase() !== invoice.currency.toUpperCase()) {
      return yield* new InvalidState({
        message: `Stripe charged ${input.stripe.currency.toUpperCase()} but invoice ${invoice.number} is in ${invoice.currency}`,
        code: "currency_mismatch",
      })
    }

    if (!isStripe && (before.fullyCredited || invoice.status === "credited")) {
      return yield* new InvalidState({
        message: `Invoice ${invoice.number} is fully credited and cannot receive payments`,
        code: "invoice_credited",
      })
    }

    if (input.amount === undefined && before.balanceDue.isZero()) {
      return yield* new InvalidState({
        message: `Invoice ${invoice.number} has no balance due`,
        code: "invoice_already_paid",
      })
    }

    const amount = input.amount === undefined ? before.balanceDue : toAmount(input.amount)

    if (!isStripe) {
      if (before.balanceDue.isZero()) {
        return yield* new InvalidState({
          message: `Invoice ${invoice.number} is already paid`,
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

function parsePaidAt(value: string, now: Date) {
  const paidAt = new Date(value)
  if (paidAt.getTime() > now.getTime() + FUTURE_DATE_TOLERANCE_MS) {
    return Effect.fail(
      new ValidationFailed({
        message: "The payment date cannot be in the future",
        issues: [{ path: "paidAt", message: "The payment date cannot be in the future" }],
      })
    )
  }
  return Effect.succeed(paidAt)
}

export const recordPayment = defineCommand({
  type: "payment.record",
  permission: "payment:create",
  outwardFacing: true,
  input: paymentRecordInputSchema,
  summarize: (input) =>
    `Record a ${input.amount.toFixed(2)} ${input.method.replaceAll("_", " ")} payment on invoice ${input.invoiceId}`,
  handle: (input) =>
    Effect.gen(function* () {
      const { now } = yield* Command
      const paidAt = yield* parsePaidAt(input.paidAt, now)
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
  /** Major units converted from the session's `amount_total`; omitted pays the balance due. */
  amount: z.number().positive().optional(),
  currency: z.string().nullable(),
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

export const voidPayment = defineCommand({
  type: "payment.void",
  permission: "payment:void",
  outwardFacing: true,
  input: paymentVoidInputSchema,
  summarize: (input) => `Void payment ${input.paymentId}: ${input.reason}`,
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
export const paymentCommands = [recordPayment, recordStripeCheckoutPayment, voidPayment] as const
