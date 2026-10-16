import type { Prisma } from "../../../generated/prisma/client"

/** Legacy payment metadata, never an entitlement or access decision. */
export type SubscriptionStatus = "free" | "trialing" | "expired" | "active" | "canceled" | "past_due"
export type ReadOnlyReason = "trial_ended" | "payment_failed" | "canceled"

/** Resolved by the server provider. Clients must never infer access from payment status or clocks. */
export type OrganizationAccess =
  | { state: "self_hosted" | "subscribed" | "complimentary" }
  | { state: "trial"; daysLeft: number; trialStart: number; trialEnd: number; progress: number }
  | { state: "read_only"; reason: ReadOnlyReason; trialEnd?: number | null }

export type BillingSubscription = {
  organizationAccess: OrganizationAccess
  status: SubscriptionStatus
  priceId: string | null
  trialStart?: number | null
  trialEnd?: number | null
  renewalDate?: number | null
  invoiceHistory?: Array<{ id: string; amountPaid: number; created: number; url: string | null }>
  paymentMethod?: { brand: string; last4: string } | null
  plan?: { name: string; unitAmount: number; currency: string; interval: "month"; taxBehavior: "inclusive" | "exclusive" } | null
  /** Required billing action capabilities. These never grant organization access. */
  access: {
    paidOnly: boolean
    hasSubscription: boolean
    checkoutAvailable: boolean
    portalAvailable: boolean
  }
}

export type BillingProvider = {
  getSubscription: (organizationId: string) => Promise<BillingSubscription>
  /** Legacy adapter hook. Core write checks use getSubscription().organizationAccess. */
  assertInvoiceCreationAllowed: (organizationId: string) => Promise<void>
  /** Called after successful onboarding, including registry outages. Must be transactional and
   * idempotent per organization. Later verification retries must preserve the original window.
   * cvrVerified=false records a pending identity; it must not suppress the organization trial. */
  startTrial?: (organizationId: string, context?: { cvr: string; cvrVerified: boolean; tx: Prisma.TransactionClient }) => Promise<void>
  createCheckoutSession?: (organizationId: string) => Promise<{ url: string | null }>
  createPortalSession?: (organizationId: string) => Promise<{ url: string | null }>
}

