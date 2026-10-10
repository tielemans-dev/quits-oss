export type SubscriptionStatus = "free" | "active" | "canceled" | "past_due"

export type BillingSubscription = {
  status: SubscriptionStatus
  priceId: string | null
  /** Optional distribution presentation. Access decisions always remain server-side. */
  access?: {
    paidOnly: boolean
    hasSubscription: boolean
    checkoutAvailable: boolean
    portalAvailable: boolean
  }
}

export type BillingProvider = {
  getSubscription: (organizationId: string) => Promise<BillingSubscription>
  assertInvoiceCreationAllowed: (organizationId: string) => Promise<void>
  createCheckoutSession?: (organizationId: string) => Promise<{ url: string | null }>
  createPortalSession?: (organizationId: string) => Promise<{ url: string | null }>
}

