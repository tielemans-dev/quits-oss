/**
 * Stripe account that creates and expires Checkout Sessions for an organization.
 * BYOK uses that organization's secret key. Connect uses a platform client and
 * charges the connected account directly via the Stripe-Account header.
 *
 * The client is structural so this runtime contract does not import the Stripe SDK.
 * The invoice payment provider is the only module allowed to import it.
 */
export type StripeConnectCheckoutClient = {
  checkout: {
    sessions: {
      create(
        params: object,
        options?: { stripeAccount?: string; timeout?: number }
      ): Promise<{ id: string; url: string | null }>
      expire(
        id: string,
        options?: { stripeAccount?: string; timeout?: number }
      ): Promise<unknown>
      retrieve(
        id: string,
        options?: { stripeAccount?: string; timeout?: number }
      ): Promise<{ status: string | null }>
    }
  }
}

export type StripeCheckoutTarget =
  | {
      kind: "byok"
      secretKey: string
      webhookSecret: string
    }
  | {
      kind: "connect"
      client: StripeConnectCheckoutClient
      stripeAccount: string
    }

export type StripeCheckoutTargetContext = {
  organizationId: string
}
