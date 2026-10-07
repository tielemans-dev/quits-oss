import "dotenv/config"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../db"
import { decryptSecret } from "../secrets"
import { getStripePaymentConfigurationState } from "../payments/stripe"
import { appRouter } from "../../trpc/router"
import { ensureTestMembership } from "../../test-utils/membership"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip

describe("stripe payment configuration state", () => {
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
})

describeIfDatabase("stripe payment configuration persistence", () => {
  afterEach(async () => {
    await prisma.organization.deleteMany({
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
