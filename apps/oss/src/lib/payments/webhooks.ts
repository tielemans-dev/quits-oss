import { stripeCheckoutSessionSchema, type StripeCheckoutSession } from "@yaip/contracts/payments"
import {
  recordStripeCheckoutFailure,
  recordStripeCheckoutPayment,
} from "../../domain/commands/payments"
import { executeCommand } from "../../domain/execute"
import { prisma } from "../db"
import { appLogger } from "../observability"
import { decryptSecret } from "../secrets"
import { constructStripeWebhookEvent } from "./stripe"
import { fromStripeMinorUnits } from "./stripe-amounts"

const paymentsLogger = appLogger.child("payments")

/** Checkout events that mean money was collected, once the session reports `paid`. */
const PAYMENT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
])

const PAYMENT_FAILED_EVENT = "checkout.session.async_payment_failed"

export type StripeWebhookResult = {
  handled: boolean
  alreadyApplied: boolean
}

type StripeWebhookEventResult = StripeWebhookResult & {
  /** The invoice exists but belongs to another organization than the one whose secret verified. */
  foreignInvoice?: true
}

const notHandled: StripeWebhookResult = { handled: false, alreadyApplied: false }

/**
 * Verifies a webhook against every organization's secret. Several organizations can share one
 * Stripe account and therefore one secret, so a verified event whose invoice belongs to another
 * organization moves on to the next verifying organization instead of being dropped. An
 * organization's secret only ever settles that organization's invoices.
 */
export async function processStripeWebhookRequest(
  payload: string,
  signature: string
): Promise<StripeWebhookResult> {
  const candidateSettings = await prisma.orgSettings.findMany({
    where: {
      stripeWebhookSecretEnc: {
        not: null,
      },
    },
    select: {
      organizationId: true,
      stripeWebhookSecretEnc: true,
    },
    orderBy: { organizationId: "asc" },
  })

  let verifiedCount = 0
  for (const settings of candidateSettings) {
    let event: ReturnType<typeof constructStripeWebhookEvent>
    try {
      event = constructStripeWebhookEvent({
        payload,
        signature,
        webhookSecret: decryptSecret(settings.stripeWebhookSecretEnc ?? ""),
      })
    } catch {
      continue
    }

    verifiedCount += 1
    const result = await processStripeWebhookEvent(event, {
      organizationId: settings.organizationId,
    })
    if (!result.foreignInvoice) {
      return { handled: result.handled, alreadyApplied: result.alreadyApplied }
    }
  }

  if (verifiedCount > 0) {
    paymentsLogger.warn("stripe.webhook.no_owning_organization", {
      verifiedCount,
      candidateCount: candidateSettings.length,
    })
    return notHandled
  }

  paymentsLogger.warn("stripe.webhook.invalid_signature", {
    candidateCount: candidateSettings.length,
  })
  throw new Error("Invalid Stripe webhook signature")
}

function paymentIntentIdOf(session: StripeCheckoutSession) {
  return typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id ?? null
}

export async function processStripeWebhookEvent(
  event: {
    type: string
    created?: number
    data: { object: unknown }
  },
  options: {
    /** The organization whose webhook secret verified the event; it must own the invoice. */
    organizationId?: string
  } = {}
): Promise<StripeWebhookEventResult> {
  const isPaymentEvent = PAYMENT_EVENTS.has(event.type)
  if (!isPaymentEvent && event.type !== PAYMENT_FAILED_EVENT) {
    paymentsLogger.info("stripe.webhook.unhandled", {
      eventType: event.type,
    })
    return notHandled
  }

  const parsedSession = stripeCheckoutSessionSchema.safeParse(event.data.object)
  if (!parsedSession.success) {
    paymentsLogger.warn("stripe.webhook.malformed_session", {
      eventType: event.type,
    })
    return notHandled
  }

  const session = parsedSession.data
  const invoiceId = session.metadata?.invoiceId ?? session.client_reference_id

  if (!invoiceId || !session.id) {
    paymentsLogger.warn("stripe.webhook.missing_invoice", {
      eventType: event.type,
      checkoutSessionPresent: Boolean(session.id),
    })
    return notHandled
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      organizationId: true,
      currency: true,
    },
  })

  if (!invoice) {
    paymentsLogger.warn("stripe.webhook.invoice_not_found", {
      eventType: event.type,
      invoiceId,
    })
    return notHandled
  }

  if (options.organizationId && invoice.organizationId !== options.organizationId) {
    paymentsLogger.info("stripe.webhook.foreign_invoice", {
      eventType: event.type,
      invoiceId,
    })
    return { ...notHandled, foreignInvoice: true }
  }

  const actor = {
    kind: "system",
    reason: "stripe_webhook",
    organizationId: invoice.organizationId,
    label: "Stripe",
  } as const
  const paymentIntentId = paymentIntentIdOf(session)

  if (!isPaymentEvent) {
    const outcome = await executeCommand(
      recordStripeCheckoutFailure,
      {
        invoiceId: invoice.id,
        checkoutSessionId: session.id,
        paymentIntentId,
        reason: `Stripe could not collect the asynchronous payment for checkout session ${session.id}`,
      },
      { actor, clientRequestId: `${session.id}:async_payment_failed` }
    )
    if (outcome.status !== "completed") {
      paymentsLogger.error("stripe.webhook.failure_not_recorded", {
        invoiceId: invoice.id,
        eventType: event.type,
        checkoutSessionId: session.id,
        error: outcome.status === "awaiting_approval" ? outcome.status : outcome.error,
      })
      return notHandled
    }
    return { handled: true, alreadyApplied: false }
  }

  if (session.payment_status !== "paid") {
    // Asynchronous methods complete checkout before the money arrives; the
    // `async_payment_succeeded` event records it later.
    paymentsLogger.info("stripe.webhook.payment_not_collected", {
      invoiceId: invoice.id,
      eventType: event.type,
      checkoutSessionId: session.id,
      paymentStatus: session.payment_status ?? null,
    })
    return notHandled
  }

  if (!session.currency || session.currency.toUpperCase() !== invoice.currency.toUpperCase()) {
    paymentsLogger.error("stripe.webhook.currency_mismatch", {
      invoiceId: invoice.id,
      eventType: event.type,
      checkoutSessionId: session.id,
      sessionCurrency: session.currency ?? null,
      invoiceCurrency: invoice.currency,
    })
    return notHandled
  }

  if (typeof session.amount_total !== "number" || session.amount_total <= 0) {
    // Never assume the balance was paid: record only what Stripe reports it collected.
    paymentsLogger.error("stripe.webhook.missing_amount", {
      invoiceId: invoice.id,
      eventType: event.type,
      checkoutSessionId: session.id,
      amountTotal: session.amount_total ?? null,
    })
    return notHandled
  }

  const existing = await prisma.payment.findUnique({
    where: { stripeCheckoutSessionId: session.id },
    select: { id: true },
  })
  if (existing) {
    paymentsLogger.info("stripe.webhook.already_applied", {
      invoiceId: invoice.id,
      eventType: event.type,
      paymentId: existing.id,
    })
    return { handled: true, alreadyApplied: true }
  }

  const outcome = await executeCommand(
    recordStripeCheckoutPayment,
    {
      invoiceId: invoice.id,
      checkoutSessionId: session.id,
      paymentIntentId,
      amount: fromStripeMinorUnits(session.amount_total, session.currency),
      currency: session.currency,
      paidAt: (event.created ? new Date(event.created * 1000) : new Date()).toISOString(),
    },
    { actor, clientRequestId: session.id }
  )

  if (outcome.status !== "completed") {
    paymentsLogger.error("stripe.webhook.payment_failed", {
      invoiceId: invoice.id,
      eventType: event.type,
      checkoutSessionId: session.id,
      error: outcome.status === "awaiting_approval" ? outcome.status : outcome.error,
    })
    return notHandled
  }

  paymentsLogger.info("stripe.webhook.applied", {
    invoiceId: invoice.id,
    eventType: event.type,
    checkoutSessionId: session.id,
    paymentIntentId,
    paymentId: outcome.result.payment.id,
  })

  return { handled: true, alreadyApplied: outcome.result.alreadyApplied }
}
