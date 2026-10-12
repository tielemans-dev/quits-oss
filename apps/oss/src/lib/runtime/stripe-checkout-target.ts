import type Stripe from "stripe"

/**
 * Stripe account that creates and expires Checkout Sessions for an organization.
 * BYOK uses that organization's secret key. Connect uses a platform client and
 * charges the connected account directly via the Stripe-Account header.
 */
export type StripeCheckoutTarget =
  | {
      kind: "byok"
      secretKey: string
      webhookSecret: string
    }
  | {
      kind: "connect"
      client: Stripe
      stripeAccount: string
    }

export type StripeCheckoutTargetContext = {
  organizationId: string
}
