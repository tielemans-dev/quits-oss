import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { daCatalog as da } from "../i18n/catalog/da"
import { enCatalog as en } from "../i18n/catalog/en"
import { resolveCardCheckoutTarget } from "../payments/public-access"
import { setRuntimeExtensions } from "../runtime/extensions"
import { encryptSecret } from "../secrets"

const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }))
vi.mock("../db", () => ({ prisma: { orgSettings: { findUnique: async () => state.settings } } }))

const balanceDue = { greaterThan: (value: number) => 1250 > value, toNumber: () => 1250 }
const noStripe = { stripePublishableKey: null, stripeSecretKeyEnc: null, stripeWebhookSecretEnc: null, stripeAccountStatus: "none" as const }
const connectExtension = {
  id: "test-connect",
  resolveStripeCheckoutTarget: async () => ({ kind: "connect" as const, stripeAccount: "acct_test", client: {} as never }),
}

function resolve(settings: Parameters<typeof resolveCardCheckoutTarget>[0]["settings"]) {
  state.settings = settings ?? {}
  return resolveCardCheckoutTarget({ organizationId: "org-1", settings, paymentState: "unpaid", balanceDue, currency: "DKK" })
}

describe("payment link card target", () => {
  beforeEach(() => vi.stubEnv("BETTER_AUTH_SECRET", "payment-link-test-secret"))
  afterEach(() => { setRuntimeExtensions([]); vi.unstubAllEnvs() })

  const byok = () => ({
    stripePublishableKey: "pk_test_123456789",
    stripeSecretKeyEnc: encryptSecret("sk_test_synthetic"),
    stripeWebhookSecretEnc: encryptSecret("whsec_synthetic"),
  })

  it("offers no card without Stripe, so the link is bank transfer only", async () => {
    expect(await resolve(noStripe)).toBeNull()
  })

  it("offers card when self-hosted Stripe keys are configured", async () => {
    expect(await resolve({ ...byok(), stripeAccountStatus: "none" })).toMatchObject({ kind: "byok" })
  })

  it.each(["none", "pending", "restricted"] as const)("offers no card on hosted with Stripe keys and %s Connect", async status => {
    setRuntimeExtensions([connectExtension])
    expect(await resolve({ ...byok(), stripeAccountStatus: status })).toBeNull()
  })

  it("offers card on hosted with active Connect", async () => {
    setRuntimeExtensions([connectExtension])
    expect(await resolve({ ...noStripe, stripeAccountStatus: "active" })).toMatchObject({ kind: "connect" })
  })

  it("offers no card once the invoice is paid", async () => {
    state.settings = { ...byok(), stripeAccountStatus: "none" }
    expect(await resolveCardCheckoutTarget({ organizationId: "org-1", settings: state.settings as never, paymentState: "paid", balanceDue, currency: "DKK" })).toBeNull()
  })
})

describe("payment link helper copy", () => {
  it.each([["en", en], ["da", da]] as const)("names Stripe only for the card variant in %s", (_locale, catalog) => {
    expect(catalog["invoices.detail.paymentLink.description.card"]).toContain("Stripe")
    expect(catalog["invoices.detail.paymentLink.description.bankTransfer"]).not.toContain("Stripe")
  })
})
