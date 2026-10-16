import { describe, expect, it } from "vitest"
import { NoopBillingProvider } from "../noop-provider"

describe("NoopBillingProvider", () => {
  it("returns free subscription for every organization", async () => {
    const provider = new NoopBillingProvider()
    await expect(provider.getSubscription("org-1")).resolves.toEqual({
      status: "free", organizationAccess: { state: "self_hosted" },
      priceId: null,
    })
  })

  it("does not block invoice creation", async () => {
    const provider = new NoopBillingProvider()
    await expect(provider.assertInvoiceCreationAllowed("org-1")).resolves.toBeUndefined()
  })

  it("does not provide checkout or portal urls", async () => {
    const provider = new NoopBillingProvider()
    await expect(provider.createCheckoutSession("org-1")).resolves.toEqual({ url: null })
    await expect(provider.createPortalSession("org-1")).resolves.toEqual({ url: null })
  })
})

