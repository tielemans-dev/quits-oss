import { afterEach, describe, expect, it, vi } from "vitest"

async function loadModule() {
  vi.resetModules()
  return import("../runtime/services")
}

describe("runtime service registration", () => {
  afterEach(async () => {
    const mod = await loadModule()
    mod.resetRuntimeServices()
  })

  it("uses noop billing provider by default", async () => {
    const mod = await loadModule()

    const subscription = await mod.getBillingProvider().getSubscription("org-1")
    expect(subscription).toEqual({ status: "free", organizationAccess: { state: "self_hosted" }, priceId: null, access: { paidOnly: false, hasSubscription: false, checkoutAvailable: false, portalAvailable: false } })
  })

  it("allows overriding billing provider at runtime", async () => {
    const mod = await loadModule()

    mod.setRuntimeServices({
      billingProvider: {
        getSubscription: async () => ({ status: "active", organizationAccess: { state: "subscribed" }, priceId: "price_123", access: { paidOnly: false, hasSubscription: false, checkoutAvailable: false, portalAvailable: false } }),
        assertInvoiceCreationAllowed: async () => {},
      },
    })

    const subscription = await mod.getBillingProvider().getSubscription("org-1")
    expect(subscription).toEqual({ status: "active", organizationAccess: { state: "subscribed" }, priceId: "price_123", access: { paidOnly: false, hasSubscription: false, checkoutAvailable: false, portalAvailable: false } })
  })

  it("provides a default onboarding ai service and supports override", async () => {
    const mod = await loadModule()

    const suggested = await mod.getOnboardingAiService().suggestPatch({
      userMessage: "We are in Denmark and use VAT. billing@acme.example",
      currentValues: {},
      missing: ["companyName", "companyAddress", "companyEmail"],
    })
    expect(suggested.patch.countryCode).toBe("DK")

    mod.setRuntimeServices({
      onboardingAiService: {
        suggestPatch: async () => ({
          patch: { companyName: "Custom Name" },
          rationale: "test",
          confidence: 1,
          followupQuestions: [],
        }),
      },
    })

    const overridden = await mod.getOnboardingAiService().suggestPatch({
      userMessage: "unused",
      currentValues: {},
      missing: [],
    })
    expect(overridden.patch.companyName).toBe("Custom Name")
  })

  it("provides an unsupported managed document domain provider by default", async () => {
    const mod = await loadModule()

    expect(mod.getManagedDocumentDomainProvider().supported).toBe(false)
    await expect(
      mod.getManagedDocumentDomainProvider().createDomain({
        domain: "billing.acme.com",
      })
    ).rejects.toThrow("Managed document domains are not available")
  })

  it("allows overriding the managed document domain provider at runtime", async () => {
    const mod = await loadModule()

    mod.setRuntimeServices({
      managedDocumentDomainProvider: {
        supported: true,
        createDomain: async ({ domain }) => ({
          providerId: "domain_123",
          domain,
          status: "pending_dns",
          records: [],
          failureReason: null,
          verifiedAt: null,
        }),
        refreshDomain: async ({ domain }) => ({
          providerId: "domain_123",
          domain,
          status: "verified",
          records: [],
          failureReason: null,
          verifiedAt: new Date("2026-03-06T18:00:00.000Z"),
        }),
        deleteDomain: async () => {},
      },
    })

    const created = await mod.getManagedDocumentDomainProvider().createDomain({
      domain: "billing.acme.com",
    })

    expect(created.providerId).toBe("domain_123")
    expect(created.status).toBe("pending_dns")
  })
})
