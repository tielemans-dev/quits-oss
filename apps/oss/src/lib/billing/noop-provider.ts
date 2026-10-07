import type { BillingProvider, BillingSubscription } from "./types"

export class NoopBillingProvider implements Required<BillingProvider> {
  async getSubscription(_organizationId: string): Promise<BillingSubscription> {
    return {
      status: "free",
      priceId: null,
    }
  }

  async assertInvoiceCreationAllowed(_organizationId: string) {
    // Self-host distribution has no hosted billing limits.
  }

  async createCheckoutSession(_organizationId: string) {
    return { url: null }
  }

  async createPortalSession(_organizationId: string) {
    return { url: null }
  }
}
