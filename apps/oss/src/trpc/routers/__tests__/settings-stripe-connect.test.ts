import { beforeEach, describe, expect, it, vi } from "vitest"
import { decryptSecret } from "../../../lib/secrets"
import { settingsRouter } from "../settings"

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  txFindUnique: vi.fn(),
  txUpsert: vi.fn(),
  paymentsManaged: false,
}))

vi.mock("../../../lib/db", () => ({
  prisma: {
    organizationTaxId: { findFirst: mocks.findFirst },
    orgSettings: { findUnique: mocks.findUnique },
    $transaction: vi.fn(async (run: (tx: unknown) => unknown) =>
      run({ orgSettings: { findUnique: mocks.txFindUnique, upsert: mocks.txUpsert } })
    ),
  },
}))

vi.mock("../../../domain/documents/base-currency", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../domain/documents/base-currency")>()),
  hasIssuedDocuments: async () => false,
  resolveBaseCurrency: async () => "DKK",
}))

vi.mock("../../../domain/actor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../domain/actor")>()),
  actorCan: () => true,
}))

vi.mock("../../../domain/user-actor", () => ({
  resolveUserActor: async () => ({
    kind: "user",
    organizationId: "org-1",
    userId: "user-1",
    roles: ["owner"],
    label: "Test User",
  }),
}))

vi.mock("../../../lib/runtime/extensions", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../lib/runtime/extensions")>()
  return {
    ...original,
    getRuntimeCapabilities: () => ({
      ...original.getRuntimeCapabilities({}),
      payments: {
        enabled: mocks.paymentsManaged,
        managed: mocks.paymentsManaged,
        provider: mocks.paymentsManaged ? "stripe" : null,
      },
    }),
  }
})

const statusAt = new Date("2026-10-12T12:00:00.000Z")

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "settings-1",
    countryCode: "DK",
    locale: "da-DK",
    timezone: "Europe/Copenhagen",
    defaultCurrency: "DKK",
    baseCurrency: "DKK",
    onboardingInvoicingIdentity: null,
    taxRegime: "eu_vat",
    pricesIncludeTax: true,
    currency: "DKK",
    taxRate: null,
    companyName: "Acme",
    companyAddress: null,
    companyEmail: null,
    companyPhone: null,
    companyLogo: null,
    invoicePrefix: "INV",
    invoiceNextNum: 1,
    quotePrefix: "QTE",
    quoteNextNum: 1,
    creditNotePrefix: "CN",
    creditNoteNextNum: 1,
    aiProvider: "openrouter",
    aiBaseUrl: null,
    aiApiKeyEnc: null,
    aiModel: "openai/gpt-4o-mini",
    stripePublishableKey: "pk_test_123456789",
    stripeSecretKeyEnc: "enc-secret",
    stripeWebhookSecretEnc: "enc-webhook",
    stripeAccountId: null,
    stripeAccountStatus: "none",
    stripeAccountStatusAt: null,
    documentSendingDomain: null,
    documentSendingDomainProviderId: null,
    documentSendingDomainStatus: null,
    documentSendingDomainRecords: null,
    documentSendingDomainFailureReason: null,
    documentSendingDomainVerifiedAt: null,
    documentSendingLastSyncedAt: null,
    documentSendingLastSyncSource: null,
    ...overrides,
  }
}

function createCaller() {
  return settingsRouter.createCaller({
    session: {
      user: { id: "user-1", name: "Test User", email: "test@example.com" },
      session: { activeOrganizationId: "org-1" },
    },
    requestedOrganizationId: null,
  } as never)
}

const byokKeys = {
  stripePublishableKey: "pk_test_123456789",
  stripeSecretKey: "sk_test_12345678901234567890",
  stripeWebhookSecret: "whsec_12345678901234567890",
}

describe("settings stripe account contract", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.paymentsManaged = false
    mocks.findFirst.mockResolvedValue(null)
    mocks.txFindUnique.mockResolvedValue({
      countryCode: "DK",
      aiProvider: "openrouter",
      aiBaseUrl: null,
    })
    mocks.txUpsert.mockImplementation(async ({ update }: { update: Record<string, unknown> }) => update)
  })

  it("returns byok mode and the stored connect status when payments are not managed", async () => {
    mocks.findUnique.mockResolvedValue(settingsRow())

    const settings = await createCaller().get()

    expect(settings.stripeAccount).toEqual({
      mode: "byok",
      accountId: null,
      status: "none",
      statusAt: null,
    })
    expect(settings.stripePublishableKey).toBe("pk_test_123456789")
  })

  it("returns connect mode when payments are managed", async () => {
    mocks.paymentsManaged = true
    mocks.findUnique.mockResolvedValue(
      settingsRow({
        stripeAccountId: "acct_test",
        stripeAccountStatus: "active",
        stripeAccountStatusAt: statusAt,
      })
    )

    const settings = await createCaller().get()

    expect(settings.stripeAccount).toEqual({
      mode: "connect",
      accountId: "acct_test",
      status: "active",
      statusAt: "2026-10-12T12:00:00.000Z",
    })
  })

  it("stores Stripe keys when payments are not managed", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-at-least-16")

    await createCaller().update(byokKeys)

    const update = mocks.txUpsert.mock.calls[0]?.[0].update
    expect(update.stripePublishableKey).toBe("pk_test_123456789")
    expect(decryptSecret(update.stripeSecretKeyEnc)).toBe("sk_test_12345678901234567890")
    expect(decryptSecret(update.stripeWebhookSecretEnc)).toBe("whsec_12345678901234567890")
    vi.unstubAllEnvs()
  })

  it("refuses Stripe key writes when payments are managed", async () => {
    mocks.paymentsManaged = true

    await expect(createCaller().update(byokKeys)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Stripe keys cannot be saved while card payments are managed",
    })
    await expect(createCaller().update({ clearStripeSecretKey: true })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    await expect(createCaller().update({ clearStripeWebhookSecret: true })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    expect(mocks.txUpsert).not.toHaveBeenCalled()
  })

  it("still saves other settings when payments are managed", async () => {
    mocks.paymentsManaged = true

    await createCaller().update({ companyName: "Managed Acme" })

    const update = mocks.txUpsert.mock.calls[0]?.[0].update
    expect(update.companyName).toBe("Managed Acme")
    expect(update.stripePublishableKey).toBeUndefined()
    expect(update.stripeSecretKeyEnc).toBeUndefined()
    expect(update.stripeWebhookSecretEnc).toBeUndefined()
  })
})
