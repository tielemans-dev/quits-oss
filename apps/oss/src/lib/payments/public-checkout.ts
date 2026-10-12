import { buildAbsoluteUrl, resolveAppOrigin } from "@quits/shared/http"
import { computeSettlement } from "../../domain/documents/settlement"
import { prisma } from "../db"
import { appLogger } from "../observability"
import { loadPublicInvoiceByToken } from "./public-access"
import { getPublicInvoicePaymentSecret } from "./public"
import {
  createStripeInvoiceCheckoutSession,
  expireOpenStripeCheckoutSession,
  getStripePaymentCredentials,
} from "./stripe"
import { currencyFractionDigits, isExactInCurrency } from "./stripe-amounts"
import { readProductEnv } from "@quits/shared/runtimeEnv"
import { asIssued } from "../../domain/documents/numbering"

const paymentsLogger = appLogger.child("payments")

/**
 * How often to open a new session when the balance changed while one was being opened. Each
 * retry needs another settlement change to land in that window, so this is reached only under
 * constant concurrent changes.
 */
const MAX_CHECKOUT_ATTEMPTS = 3

/**
 * Opens a Stripe Checkout session for what the customer still owes. An invoice tracks one open
 * session (`stripeCheckoutSessionId`): opening a new one expires the previous one, and a change
 * to the balance due expires it too (see `domain/documents/checkout-sessions.ts`), so a session
 * never charges a balance that is no longer owed.
 */
export async function resolvePublicInvoiceCheckout(token: string) {
  for (let attempt = 1; attempt <= MAX_CHECKOUT_ATTEMPTS; attempt += 1) {
    const outcome = await openCheckoutSession(token)
    if (outcome.status !== "retry") {
      return outcome
    }
    paymentsLogger.info("invoice.checkout.balance_changed", { attempt })
  }
  return { url: null, status: "unavailable" } as const
}

async function openCheckoutSession(token: string) {
  const session = await loadPublicInvoiceByToken(token, getPublicInvoicePaymentSecret())
  if (!session) {
    paymentsLogger.warn("invoice.checkout.invalid", {
      tokenPresent: token.length > 0,
    })
    return { url: null, status: "invalid" } as const
  }

  // Customers pay what they still owe, not the invoice total: earlier partial payments and
  // credit notes reduce the checkout amount.
  const { balanceDue } = computeSettlement(session.invoice)

  if (session.paymentState === "paid" || balanceDue.isZero()) {
    paymentsLogger.info("invoice.checkout.already_paid", {
      invoiceId: session.invoice.id,
      organizationId: session.invoice.organizationId,
    })
    return { url: null, status: "paid" } as const
  }

  // Stripe charges whole minor units. Rounding a balance such as 100.49 JPY would leave an
  // uncollectible remainder or overcharge the customer, so refuse instead.
  if (!isExactInCurrency(balanceDue.toNumber(), session.invoice.currency)) {
    paymentsLogger.warn("invoice.checkout.unavailable", {
      invoiceId: session.invoice.id,
      organizationId: session.invoice.organizationId,
      reason: "balance_not_representable_in_currency",
      currency: session.invoice.currency,
      currencyFractionDigits: currencyFractionDigits(session.invoice.currency),
      balanceDue: balanceDue.toFixed(),
    })
    return { url: null, status: "unavailable" } as const
  }

  const settings = await prisma.orgSettings.findUnique({
    where: { organizationId: session.invoice.organizationId },
    select: {
      stripePublishableKey: true,
      stripeSecretKeyEnc: true,
      stripeWebhookSecretEnc: true,
    },
  })

  const credentials = getStripePaymentCredentials({
    stripePublishableKey: settings?.stripePublishableKey ?? null,
    stripeSecretKeyEnc: settings?.stripeSecretKeyEnc ?? null,
    stripeWebhookSecretEnc: settings?.stripeWebhookSecretEnc ?? null,
  })

  if (!credentials) {
    paymentsLogger.warn("invoice.checkout.unavailable", {
      invoiceId: session.invoice.id,
      organizationId: session.invoice.organizationId,
      reason: "stripe_not_configured",
    })
    return { url: null, status: "unavailable" } as const
  }

  const logContext = {
    invoiceId: session.invoice.id,
    organizationId: session.invoice.organizationId,
  }

  // Only one session per invoice stays open, so a balance change has one session to expire.
  const previousSessionId = session.invoice.stripeCheckoutSessionId
  if (previousSessionId && !(await paymentCameFrom(previousSessionId))) {
    try {
      await expireOpenStripeCheckoutSession({ secretKey: credentials.secretKey, sessionId: previousSessionId })
    } catch (error) {
      paymentsLogger.error("invoice.checkout.unavailable", {
        ...logContext,
        reason: "previous_session_not_expired",
        checkoutSessionId: previousSessionId,
        error,
      })
      return { url: null, status: "unavailable" } as const
    }
  }

  const publicUrl = buildAbsoluteUrl(
    resolveAppOrigin(
      [
        readProductEnv(process.env, "APP_ORIGIN"),
        process.env.BETTER_AUTH_URL,
        "http://localhost:3000",
      ],
      "http://localhost:3000"
    ),
    `/pay/${encodeURIComponent(token)}`
  )

  const checkoutSession = await createStripeInvoiceCheckoutSession({
    credentials,
    invoice: asIssued(session.invoice),
    amountDue: balanceDue.toNumber(),
    successUrl: publicUrl,
    cancelUrl: publicUrl,
  })

  // Track the new session unless another request replaced the tracked one meanwhile. The update
  // waits for any payment or credit note in progress on the invoice (they lock its row), so the
  // balance read after it is current: a change that committed first is caught below, and one that
  // commits later sees this session and expires it.
  const tracked = await prisma.invoice.updateMany({
    where: { id: session.invoice.id, stripeCheckoutSessionId: previousSessionId },
    data: { stripeCheckoutSessionId: checkoutSession.id },
  })
  const current = await prisma.invoice.findUniqueOrThrow({
    where: { id: session.invoice.id },
    select: { totalGross: true, amountPaid: true, amountCredited: true },
  })

  if (tracked.count === 1 && computeSettlement(current).balanceDue.equals(balanceDue)) {
    paymentsLogger.info("invoice.checkout.redirect", {
      ...logContext,
      checkoutSessionId: checkoutSession.id,
      amountDue: balanceDue.toNumber(),
    })
    return { url: checkoutSession.url, status: "redirect" } as const
  }

  // The session charges a stale balance, or is not the one the invoice tracks: never hand it out.
  try {
    await expireOpenStripeCheckoutSession({ secretKey: credentials.secretKey, sessionId: checkoutSession.id })
  } catch (error) {
    paymentsLogger.error("invoice.checkout.unavailable", {
      ...logContext,
      reason: "stale_session_not_expired",
      checkoutSessionId: checkoutSession.id,
      error,
    })
    return { url: null, status: "unavailable" } as const
  }
  return { url: null, status: "retry" } as const
}

async function paymentCameFrom(checkoutSessionId: string) {
  const payment = await prisma.payment.findUnique({
    where: { stripeCheckoutSessionId: checkoutSessionId },
    select: { id: true },
  })
  return payment !== null
}
