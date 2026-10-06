import { stripeCheckoutSessionSchema } from "@yaip/contracts/payments"
import { prisma } from "../db"
import { appLogger } from "../observability"
import { decryptSecret } from "../secrets"
import { constructStripeWebhookEvent } from "./stripe"

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

      return processStripeWebhookEvent(event)
    } catch {
      continue
    }
  }

  paymentsLogger.warn("stripe.webhook.invalid_signature", {
    candidateCount: candidateSettings.length,
  })
  throw new Error("Invalid Stripe webhook signature")
}

export async function processStripeWebhookEvent(event: {
  type: string
  created?: number
  data: { object: unknown }
}) {
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

  if (!invoiceId) {
    paymentsLogger.warn("stripe.webhook.missing_invoice", {
      eventType: event.type,
    })
    return { handled: false, alreadyApplied: false }
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
    },
  })

  if (!invoice) {
    paymentsLogger.warn("stripe.webhook.invoice_not_found", {
      eventType: event.type,
      invoiceId,
    })
    return { handled: false, alreadyApplied: false }
  }

  if (invoice.paymentStatus === "paid" || invoice.status === "paid") {
    paymentsLogger.info("stripe.webhook.already_applied", {
      invoiceId: invoice.id,
      eventType: event.type,
    })
    return { handled: true, alreadyApplied: true }
  }

  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      status: "paid",
      paymentStatus: "paid",
      paidAt: event.created ? new Date(event.created * 1000) : new Date(),
      stripeCheckoutSessionId: session.id ?? null,
      stripePaymentIntentId: paymentIntentId,
      paymentFailureReason: null,
    },
  })

  paymentsLogger.info("stripe.webhook.applied", {
    invoiceId: invoice.id,
    eventType: event.type,
    checkoutSessionId: session.id ?? null,
    paymentIntentId,
  })

  return { handled: true, alreadyApplied: false }
}
