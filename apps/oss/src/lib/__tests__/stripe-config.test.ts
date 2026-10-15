import { cleanupTestOrganizations } from "../../test-utils/organization"
import "dotenv/config"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../db"
import { decryptSecret } from "../secrets"
import { resolveInvoiceEmailContext } from "../../domain/documents/invoice-email"
import {
  getStripePaymentConfigurationState,
  getStripePaymentCredentials,
} from "../payments/stripe"
import { appRouter } from "../../trpc/router"
import { ensureTestMembership } from "../../test-utils/membership"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip

describe("stripe payment configuration state", () => {
  afterEach(() => vi.unstubAllEnvs())
  it.each(["none", "pending", "restricted", "active"] as const)("requires active Connect on cloud even with leftover keys (%s)", status => {
    vi.stubEnv("QUITS_DISTRIBUTION", "cloud")
    const settings = { companyName: "Acme", companyEmail: null, locale: "en-US", timezone: "UTC", stripePublishableKey: "pk_saved", stripeSecretKeyEnc: "saved", stripeWebhookSecretEnc: "saved", stripeAccountStatus: status }
    expect(getStripePaymentConfigurationState(settings).configured).toBe(status === "active")
    expect(resolveInvoiceEmailContext(settings).stripeConfigured).toBe(status === "active")
    vi.unstubAllEnvs()
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

describeIfDatabase("stripe payment configuration persistence", () => {
  afterEach(async () => {
    await cleanupTestOrganizations({
      where: {
        name: "Stripe Config Org",
      },
    })
  })

  it("stores encrypted Stripe secrets and exposes configuration state through settings", async () => {
    const orgId = randomUUID()
    const slug = `stripe-config-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`

    await prisma.organization.create({
      data: {
        id: orgId,
        name: "Stripe Config Org",
        slug,
        createdAt: new Date(),
        subscriptionStatus: "pro",
      },
    })
    await ensureTestMembership(orgId, "stripe-config-user")

    const caller = appRouter.createCaller({
      session: {
        user: {
          id: "stripe-config-user",
          email: "stripe-config@example.com",
          name: "Stripe Config User",
        },
        session: {
          activeOrganizationId: orgId,
        },
      },
    } as never)

    await caller.settings.update({
      stripePublishableKey: "pk_test_123456789",
      stripeSecretKey: "sk_test_12345678901234567890",
      stripeWebhookSecret: "whsec_12345678901234567890",
    })

    const settings = await caller.settings.get()
    expect(settings.stripeByokConfigured).toBe(true)
    expect(settings.stripePublishableKey).toBe("pk_test_123456789")

    const stored = await prisma.orgSettings.findUniqueOrThrow({
      where: { organizationId: orgId },
      select: {
        stripePublishableKey: true,
        stripeSecretKeyEnc: true,
        stripeWebhookSecretEnc: true,
      },
    })

    expect(stored.stripePublishableKey).toBe("pk_test_123456789")
    expect(decryptSecret(stored.stripeSecretKeyEnc ?? "")).toBe(
      "sk_test_12345678901234567890"
    )
    expect(decryptSecret(stored.stripeWebhookSecretEnc ?? "")).toBe(
      "whsec_12345678901234567890"
    )
  })
})
