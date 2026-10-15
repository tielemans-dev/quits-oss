import { stripeCheckoutSessionSchema, type StripeCheckoutSession } from "@quits/contracts/payments"
import {
  recordStripeCheckoutFailure,
  recordStripeCheckoutPayment,
} from "../../domain/commands/payments"
import { executeCommand } from "../../domain/execute"
import { prisma } from "../db"
import { appLogger } from "../observability"
import {
  getRuntimeExtensions,
  type StripeConnectWebhookVerifier,
} from "../runtime/extensions"
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
type WebhookLogContext = { organizationId?: string; eventType?: string }

/**
 * Reads the Connect verifier supplied by the runtime, if any. The first extension that returns
 * a non-empty platform secret wins. A thrown resolver fails the request so Stripe retries,
 * rather than treating a broken hosted verifier as "no Connect".
 */
async function readStripeConnectWebhookVerifier(): Promise<StripeConnectWebhookVerifier | null> {
  for (const extension of getRuntimeExtensions()) {
    if (!extension.resolveStripeConnectWebhook) {
      continue
    }
    const verifier = await extension.resolveStripeConnectWebhook()
    if (verifier?.webhookSecret) {
      return verifier
    }
  }
  return null
}

/**
 * Tries the platform Connect secret before any organization secret. A matching signature is
 * routed with `event.account` and never falls through to BYOK, including when the account is
 * unknown or the invoice belongs to another organization. A signature that does not match
 * returns null so the caller can try organization secrets.
 */
async function processConnectStripeWebhook(
  payload: string,
  signature: string,
  context: WebhookLogContext
): Promise<StripeWebhookResult | null> {
  const verifier = await readStripeConnectWebhookVerifier()
  if (!verifier) {
    return null
  }

  let event: ReturnType<typeof constructStripeWebhookEvent>
  try {
    event = constructStripeWebhookEvent({
      payload,
      signature,
      webhookSecret: verifier.webhookSecret,
    })
  } catch {
    return null
  }

  context.eventType = event.type
  const stripeAccountId = event.account
  if (!stripeAccountId) {
    paymentsLogger.warn("stripe.webhook.connect_missing_account", {
      eventType: event.type,
    })
    return notHandled
  }

  const organizationId = await verifier.resolveOrganizationId(stripeAccountId)
  if (!organizationId) {
    paymentsLogger.info("stripe.webhook.connect_unknown_account", {
      eventType: event.type,
      stripeAccountId,
    })
    return notHandled
  }

  context.organizationId = organizationId
  const result = await processStripeWebhookEvent(event, { organizationId })
  if (result.foreignInvoice) {
    paymentsLogger.info("stripe.webhook.connect_foreign_invoice", {
      eventType: event.type,
      stripeAccountId,
    })
    return notHandled
  }

  return { handled: result.handled, alreadyApplied: result.alreadyApplied }
}

/**
 * Verifies a webhook, then settles the invoice it names.
 *
 * A runtime Connect verifier, when registered, is tried first. Its single platform secret
 * authenticates connected-account events. `event.account` selects the organization, and that
 * organization must own the invoice. An unknown account, a missing account, or another
 * organization's invoice is ignored and is not offered to BYOK secrets. A signature that does
 * not match the platform secret falls through.
 *
 * The fall-through tries every organization's own webhook secret. Several organizations can
 * share one Stripe account and therefore one secret, so a verified event whose invoice belongs
 * to another organization moves on to the next verifying organization instead of being dropped.
 * An organization's secret only ever settles that organization's invoices.
 */
export async function processStripeWebhookRequest(
  payload: string,
  signature: string
): Promise<StripeWebhookResult> {
  const context: WebhookLogContext = {}
  try {
    return await processStripeWebhookRequestUnchecked(payload, signature, context)
  } catch (error) {
    if (!(error instanceof InvalidStripeWebhookSignature)) {
      paymentsLogger.error("stripe.webhook.processing_failed", {
        ...context,
        errorType: error instanceof Error ? error.name : "UnknownError",
      })
    }
    throw error
  }
}

class InvalidStripeWebhookSignature extends Error {}

async function processStripeWebhookRequestUnchecked(
  payload: string,
  signature: string,
  context: WebhookLogContext
): Promise<StripeWebhookResult> {
  const connectResult = await processConnectStripeWebhook(payload, signature, context)
  if (connectResult) {
    return connectResult
  }

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
    context.organizationId = settings.organizationId
    context.eventType = event.type
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
  throw new InvalidStripeWebhookSignature("Invalid Stripe webhook signature")
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
