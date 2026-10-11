import type { BillingProvider } from "./types"
import { getBillingProvider } from "../runtime/services"

export const billingProvider: BillingProvider = {
  getSubscription: (organizationId) => getBillingProvider().getSubscription(organizationId),
  assertInvoiceCreationAllowed: (organizationId) =>
    getBillingProvider().assertInvoiceCreationAllowed(organizationId),
  startTrial: (organizationId) =>
    getBillingProvider().startTrial?.(organizationId) ?? Promise.resolve(),
  createCheckoutSession: (organizationId) =>
    getBillingProvider().createCheckoutSession?.(organizationId) ?? Promise.resolve({ url: null }),
  createPortalSession: (organizationId) =>
    getBillingProvider().createPortalSession?.(organizationId) ?? Promise.resolve({ url: null }),
}
