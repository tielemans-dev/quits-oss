import type { Prisma } from "../../../generated/prisma/client"

export type SubscriptionStatus = "free" | "trialing" | "expired" | "active" | "canceled" | "past_due"

export type BillingSubscription = {
  status: SubscriptionStatus
  priceId: string | null
  trialStart?: number | null
  trialEnd?: number | null
  renewalDate?: number | null
  invoiceHistory?: Array<{ id: string; amountPaid: number; created: number; url: string | null }>
  paymentMethod?: { brand: string; last4: string } | null
  plan?: { name: string; unitAmount: number; currency: string; interval: "month"; taxBehavior: "inclusive" | "exclusive" } | null
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
  /** The verified CVR and transaction include identity writes not yet visible to other connections. */
  startTrial?: (organizationId: string, context?: { cvr: string; tx: Prisma.TransactionClient }) => Promise<void>
  createCheckoutSession?: (organizationId: string) => Promise<{ url: string | null }>
  createPortalSession?: (organizationId: string) => Promise<{ url: string | null }>
}

