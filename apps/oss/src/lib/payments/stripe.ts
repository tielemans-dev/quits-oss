import Stripe from "stripe"
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

export function createStripeClient(secretKey: string) {
  return new Stripe(secretKey)
}

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
