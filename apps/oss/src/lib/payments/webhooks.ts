import { stripeCheckoutSessionSchema } from "@yaip/contracts/payments"
import { recordStripeCheckoutPayment } from "../../domain/commands/payments"
import { executeCommand } from "../../domain/execute"
import { prisma } from "../db"
import { appLogger } from "../observability"
import { decryptSecret } from "../secrets"
import { constructStripeWebhookEvent } from "./stripe"
import { fromStripeMinorUnits } from "./stripe-amounts"

const paymentsLogger = appLogger.child("payments")

export async function processStripeWebhookRequest(
  payload: string,
  signature: string
) {
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
  })

  for (const settings of candidateSettings) {
    try {
      const event = constructStripeWebhookEvent({
        payload,
        signature,
        webhookSecret: decryptSecret(settings.stripeWebhookSecretEnc ?? ""),
      })

      return processStripeWebhookEvent(event, { organizationId: settings.organizationId })
    } catch {
      continue
    }
  }

  paymentsLogger.warn("stripe.webhook.invalid_signature", {
    candidateCount: candidateSettings.length,
  })
  throw new Error("Invalid Stripe webhook signature")
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
) {
  if (event.type !== "checkout.session.completed") {
    paymentsLogger.info("stripe.webhook.unhandled", {
      eventType: event.type,
    })
    return { handled: false, alreadyApplied: false }
  }

  const parsedSession = stripeCheckoutSessionSchema.safeParse(event.data.object)
  if (!parsedSession.success) {
    paymentsLogger.warn("stripe.webhook.malformed_session", {
      eventType: event.type,
    })
    return { handled: false, alreadyApplied: false }
  }

  const session = parsedSession.data
  const invoiceId = session.metadata?.invoiceId ?? session.client_reference_id

  if (!invoiceId || !session.id) {
    paymentsLogger.warn("stripe.webhook.missing_invoice", {
      eventType: event.type,
      checkoutSessionPresent: Boolean(session.id),
    })
    return { handled: false, alreadyApplied: false }
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      organizationId: true,
      currency: true,
    },
  })

  if (!invoice || (options.organizationId && invoice.organizationId !== options.organizationId)) {
    paymentsLogger.warn("stripe.webhook.invoice_not_found", {
      eventType: event.type,
      invoiceId,
      organizationMismatch: Boolean(invoice),
    })
    return { handled: false, alreadyApplied: false }
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

  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null
  const currency = session.currency ?? invoice.currency

  const outcome = await executeCommand(
    recordStripeCheckoutPayment,
    {
      invoiceId: invoice.id,
      checkoutSessionId: session.id,
      paymentIntentId,
      amount:
        typeof session.amount_total === "number" && session.amount_total > 0
          ? fromStripeMinorUnits(session.amount_total, currency)
          : undefined,
      currency: session.currency ?? null,
      paidAt: (event.created ? new Date(event.created * 1000) : new Date()).toISOString(),
    },
    {
      actor: {
        kind: "system",
        reason: "stripe_webhook",
        organizationId: invoice.organizationId,
        label: "Stripe",
      },
      clientRequestId: session.id,
    }
  )

  if (outcome.status !== "completed") {
    paymentsLogger.error("stripe.webhook.payment_failed", {
      invoiceId: invoice.id,
      eventType: event.type,
      checkoutSessionId: session.id,
      error: outcome.status === "awaiting_approval" ? outcome.status : outcome.error,
    })
    return { handled: false, alreadyApplied: false }
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
