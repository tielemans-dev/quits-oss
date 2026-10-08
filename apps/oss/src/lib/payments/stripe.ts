import Stripe from "stripe"
import { assertOperationsLive } from "../operations-hold"
import { decryptSecret } from "../secrets"
import { toStripeMinorUnits } from "./stripe-amounts"

export type StripePaymentConfigurationSnapshot = {
  stripePublishableKey: string | null
  stripeSecretKeyEnc: string | null
  stripeWebhookSecretEnc: string | null
}

export function getStripePaymentConfigurationState(
  snapshot: StripePaymentConfigurationSnapshot
) {
  return {
    configured: Boolean(
      snapshot.stripePublishableKey &&
        snapshot.stripeSecretKeyEnc &&
        snapshot.stripeWebhookSecretEnc
    ),
  }
}

export function getStripePaymentCredentials(
  snapshot: StripePaymentConfigurationSnapshot
) {
  if (!getStripePaymentConfigurationState(snapshot).configured) {
    return null
  }

  return {
    publishableKey: snapshot.stripePublishableKey ?? "",
    secretKey: decryptSecret(snapshot.stripeSecretKeyEnc ?? ""),
    webhookSecret: decryptSecret(snapshot.stripeWebhookSecretEnc ?? ""),
  }
}

export function createStripeClient(secretKey: string, options?: { timeoutMs?: number }) {
  return new Stripe(secretKey, options?.timeoutMs ? { timeout: options.timeoutMs } : undefined)
}

/**
 * Expiring a session runs right after a payment is recorded, before the response is sent; a slow
 * Stripe must not hold that up for long. A timed-out expiry is retried by the job runner.
 */
const EXPIRE_TIMEOUT_MS = 10_000

export async function createStripeInvoiceCheckoutSession(input: {
  credentials: ReturnType<typeof getStripePaymentCredentials>
  invoice: {
    id: string
    number: string
    organizationId: string
    currency: string
  }
  /** What the customer still owes: total minus payments and credit notes, in major units. */
  amountDue: number
  successUrl: string
  cancelUrl: string
}) {
  if (!input.credentials) {
    throw new Error("Stripe payment credentials are not configured")
  }

  await assertOperationsLive("creating a Stripe Checkout session")
  const stripe = createStripeClient(input.credentials.secretKey)

  return stripe.checkout.sessions.create({
    mode: "payment",
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.invoice.id,
    metadata: {
      invoiceId: input.invoice.id,
      organizationId: input.invoice.organizationId,
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: input.invoice.currency.toLowerCase(),
          unit_amount: toStripeMinorUnits(input.amountDue, input.invoice.currency),
          product_data: {
            name: `Invoice ${input.invoice.number}`,
          },
        },
      },
    ],
  })
}

export type CheckoutSessionExpiry = "expired" | "not_open" | "missing"

function isMissingResource(error: unknown) {
  return error instanceof Stripe.errors.StripeInvalidRequestError && error.code === "resource_missing"
}

/**
 * Expires a Checkout session if it can still be paid, so a customer cannot pay an amount that is
 * no longer owed. A session that was completed, already expired, or never existed (e.g. created
 * under a Stripe key that has since been replaced) needs nothing and is reported as such.
 */
export async function expireOpenStripeCheckoutSession(input: {
  secretKey: string
  sessionId: string
}): Promise<CheckoutSessionExpiry> {
  await assertOperationsLive("expiring a Stripe Checkout session")
  const stripe = createStripeClient(input.secretKey, { timeoutMs: EXPIRE_TIMEOUT_MS })
  try {
    await stripe.checkout.sessions.expire(input.sessionId)
    return "expired"
  } catch (error) {
    if (isMissingResource(error)) {
      return "missing"
    }
    if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) {
      throw error
    }
    // Only open sessions can be expired; find out whether this one is no longer open.
    let session: Stripe.Checkout.Session
    try {
      session = await stripe.checkout.sessions.retrieve(input.sessionId)
    } catch (retrieveError) {
      if (isMissingResource(retrieveError)) {
        return "missing"
      }
      throw retrieveError
    }
    if (session.status !== "open") {
      return "not_open"
    }
    throw error
  }
}

export function constructStripeWebhookEvent(input: {
  payload: string
  signature: string
  webhookSecret: string
}) {
  const stripe = createStripeClient("sk_test_placeholder_123456789012345")
  return stripe.webhooks.constructEvent(
    input.payload,
    input.signature,
    input.webhookSecret
  )
}
