import { assertOrganizationWriteAccess } from "./organization-access"
import type { BillingProvider } from "./types"
import { getBillingProvider } from "../runtime/services"

export const billingProvider: BillingProvider = {
  getSubscription: (organizationId) => getBillingProvider().getSubscription(organizationId),
  assertInvoiceCreationAllowed: async (organizationId) =>
    assertOrganizationWriteAccess((await getBillingProvider().getSubscription(organizationId)).organizationAccess),
  startTrial: (organizationId, context) =>
    getBillingProvider().startTrial?.(organizationId, context) ?? Promise.resolve(),
  createCheckoutSession: (organizationId) =>
    getBillingProvider().createCheckoutSession?.(organizationId) ?? Promise.resolve({ url: null }),
  createPortalSession: (organizationId) =>
    getBillingProvider().createPortalSession?.(organizationId) ?? Promise.resolve({ url: null }),
}
