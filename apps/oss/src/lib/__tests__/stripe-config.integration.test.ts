import { cleanupTestOrganizations, hasTestDatabase } from "../../test-utils/organization"
import "dotenv/config"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../db"
import { decryptSecret } from "../secrets"
import { appRouter } from "../../trpc/router"
import { ensureTestMembership } from "../../test-utils/membership"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip
const organizationIds: string[] = []

describeIfDatabase("stripe payment configuration persistence", () => {
  afterEach(async () => {
    await cleanupTestOrganizations({ where: { id: { in: organizationIds.splice(0) } } })
  })

  it("stores encrypted Stripe secrets and exposes configuration state through settings", async () => {
    const orgId = randomUUID()
    organizationIds.push(orgId)
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
