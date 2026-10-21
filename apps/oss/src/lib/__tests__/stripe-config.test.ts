import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveInvoiceEmailContext } from "../../domain/documents/invoice-email"
import {
  getStripePaymentConfigurationState,
  getStripePaymentCredentials,
} from "../payments/stripe"

describe("stripe payment configuration state", () => {
  afterEach(() => vi.unstubAllEnvs())
  it.each(["none", "pending", "restricted", "active"] as const)("requires active Connect on cloud even with leftover keys (%s)", status => {
    vi.stubEnv("QUITS_DISTRIBUTION", "cloud")
    const settings = { companyName: "Acme", companyEmail: null, locale: "en-US", timezone: "UTC", stripePublishableKey: "pk_saved", stripeSecretKeyEnc: "saved", stripeWebhookSecretEnc: "saved", stripeAccountStatus: status }
    expect(getStripePaymentConfigurationState(settings).configured).toBe(status === "active")
    expect(resolveInvoiceEmailContext(settings).stripeConfigured).toBe(status === "active")
  })

  it("requires all Stripe BYOK fields before payment links are considered configured", () => {
    expect(
      getStripePaymentConfigurationState({
        stripePublishableKey: null,
        stripeSecretKeyEnc: null,
        stripeWebhookSecretEnc: null,
      }).configured
    ).toBe(false)

    expect(
      getStripePaymentConfigurationState({
        stripePublishableKey: "pk_test_123",
        stripeSecretKeyEnc: "encrypted-secret",
        stripeWebhookSecretEnc: null,
      }).configured
    ).toBe(false)

    expect(
      getStripePaymentConfigurationState({
        stripePublishableKey: "pk_test_123",
        stripeSecretKeyEnc: "encrypted-secret",
        stripeWebhookSecretEnc: "encrypted-webhook",
      }).configured
    ).toBe(true)
  })

  it("treats an active Connect account as configured without decrypting missing BYOK keys", () => {
    const snapshot = {
      stripePublishableKey: null,
      stripeSecretKeyEnc: null,
      stripeWebhookSecretEnc: null,
      stripeAccountStatus: "active" as const,
    }

    expect(getStripePaymentConfigurationState(snapshot).configured).toBe(true)
    expect(getStripePaymentCredentials(snapshot)).toBeNull()
  })

  it("keeps a non-active Connect account unconfigured when BYOK keys are missing", () => {
    for (const stripeAccountStatus of ["none", "pending", "restricted", null, undefined] as const) {
      expect(
        getStripePaymentConfigurationState({
          stripePublishableKey: null,
          stripeSecretKeyEnc: null,
          stripeWebhookSecretEnc: null,
          stripeAccountStatus,
        }).configured
      ).toBe(false)
    }
  })

  it("keeps complete BYOK configured when the Connect account is not active", () => {
    expect(
      getStripePaymentConfigurationState({
        stripePublishableKey: "pk_test_123",
        stripeSecretKeyEnc: "encrypted-secret",
        stripeWebhookSecretEnc: "encrypted-webhook",
        stripeAccountStatus: "pending",
      }).configured
    ).toBe(true)
  })

  it("marks invoice emails as payment-configured for an active Connect account without BYOK keys", () => {
    const settings = {
      companyName: "Acme",
      companyEmail: "billing@acme.test",
      locale: "en-US",
      timezone: "Europe/Copenhagen",
      stripePublishableKey: null,
      stripeSecretKeyEnc: null,
      stripeWebhookSecretEnc: null,
    }

    expect(
      resolveInvoiceEmailContext({ ...settings, stripeAccountStatus: "active" }).stripeConfigured
    ).toBe(true)
    expect(
      resolveInvoiceEmailContext({ ...settings, stripeAccountStatus: "pending" }).stripeConfigured
    ).toBe(false)
  })
})
