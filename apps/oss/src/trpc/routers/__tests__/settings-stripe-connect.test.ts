import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { decryptSecret, encryptSecret } from "../../../lib/secrets"
import { setRuntimeExtensions } from "../../../lib/runtime/extensions"
import { resetRuntimeServices, setRuntimeServices } from "../../../lib/runtime/services"
import { settingsRouter } from "../settings"

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  txFindUnique: vi.fn(),
  txUpsert: vi.fn(),
  paymentsManaged: false,
  canUpdateSettings: true,
}))

vi.mock("../../../lib/db", () => ({
  prisma: {
    organizationTaxId: { findFirst: mocks.findFirst },
    orgSettings: { findUnique: mocks.findUnique },
    $transaction: vi.fn(async (run: (tx: unknown) => unknown) =>
      run({
        orgSettings: {
          findUnique: mocks.txFindUnique,
          findUniqueOrThrow: mocks.txFindUnique,
          upsert: mocks.txUpsert,
        },
        organizationTaxId: { findFirst: mocks.findFirst },
      })
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
  actorCan: (_actor: unknown, permission: string) =>
    permission !== "settings:update" || mocks.canUpdateSettings,
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
    stripeSecretKeyEnc: encryptSecret("sk_test_12345678901234567890"),
    stripeWebhookSecretEnc: encryptSecret("whsec_12345678901234567890"),
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
    resetRuntimeServices()
    setRuntimeExtensions([])
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-at-least-16")
    vi.stubEnv("QUITS_DISTRIBUTION", "selfhost")
    mocks.paymentsManaged = false
    mocks.canUpdateSettings = true
    mocks.findFirst.mockResolvedValue(null)
    mocks.txFindUnique.mockResolvedValue({
      countryCode: "DK",
      aiProvider: "openrouter",
      aiBaseUrl: null,
      momsRegistered: null,
      stripePublishableKey: "pk_test_123456789",
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
    expect(settings.stripeConnectActions).toBe(false)
    expect(settings.stripePublishableKey).toBe("pk_test_123456789")
    expect(settings.stripeByokConfigured).toBe(true)
    expect(settings.stripePaymentsEnabled).toBe(true)
    expect(settings.stripeCheckoutKind).toBe("byok")
  })

  it("requires Connect in cloud settings even before capabilities or handlers are registered", async () => {
    vi.stubEnv("QUITS_DISTRIBUTION", "cloud")
    mocks.findUnique.mockResolvedValue(settingsRow({ stripeAccountStatus: "active" }))
    const result = await createCaller().get()
    expect(result.stripeAccount.mode).toBe("connect")
    expect(result.stripePaymentsEnabled).toBe(false)
    expect(result.stripeCheckoutKind).toBeNull()
  })

  it("does not report BYOK keys for an active Connect account without keys", async () => {
    mocks.findUnique.mockResolvedValue(
      settingsRow({
        stripePublishableKey: null,
        stripeSecretKeyEnc: null,
        stripeWebhookSecretEnc: null,
        stripeAccountId: "acct_test",
        stripeAccountStatus: "active",
        stripeAccountStatusAt: statusAt,
      })
    )

    const settings = await createCaller().get()

    expect(settings.stripeByokConfigured).toBe(false)
    expect(settings.stripePublishableKey).toBeNull()
  })

  it("does not count a non-active Connect account as payment-configured without BYOK keys", async () => {
    for (const stripeAccountStatus of ["none", "pending", "restricted"] as const) {
      mocks.findUnique.mockResolvedValue(
        settingsRow({
          stripePublishableKey: null,
          stripeSecretKeyEnc: null,
          stripeWebhookSecretEnc: null,
          stripeAccountStatus,
        })
      )

      const settings = await createCaller().get()

      expect(settings.stripeByokConfigured).toBe(false)
    }
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
    expect(settings.stripeConnectActions).toBe(false)
  })

  describe.each(["none", "pending", "restricted", "active"] as const)("%s account", (status) => {
    it.each([false, true])("reports checkout readiness with BYOK configured=%s", async (byok) => {
      mocks.paymentsManaged = true
      mocks.findUnique.mockResolvedValue(settingsRow({
        stripeAccountId: status === "none" ? null : "acct_test",
        stripeAccountStatus: status,
        ...(!byok ? {
          stripePublishableKey: null,
          stripeSecretKeyEnc: null,
          stripeWebhookSecretEnc: null,
        } : {}),
      }))

      // Managed settings never advertise stored BYOK keys as a checkout fallback.
      expect((await createCaller().get()).stripePaymentsEnabled).toBe(false)

      const resolveTarget = vi.fn(async () => ({
        kind: "connect" as const,
        stripeAccount: "acct_test",
        client: { checkout: { sessions: { create: vi.fn(), expire: vi.fn(), retrieve: vi.fn() } } },
      }))
      setRuntimeExtensions([{
        id: "test-connect-checkout",
        resolveStripeCheckoutTarget: resolveTarget,
      }])
      const result = await createCaller().get()
      expect(result.stripePaymentsEnabled).toBe(status === "active")
      expect(result.stripeCheckoutKind).toBe(status === "active" ? "connect" : null)
      expect(resolveTarget).toHaveBeenCalledTimes(status === "active" ? 1 : 0)
      expect(result.stripeByokConfigured).toBe(byok)
    })
  })

  it("reports Connect actions only when payments are managed and a handler is registered", async () => {
    mocks.findUnique.mockResolvedValue(settingsRow())
    const run = vi.fn(async () => {})
    setRuntimeServices({ stripeConnectSettings: { run } })

    expect((await createCaller().get()).stripeConnectActions).toBe(false)

    mocks.paymentsManaged = true
    expect((await createCaller().get()).stripeConnectActions).toBe(true)

    mocks.canUpdateSettings = false
    expect((await createCaller().get()).stripeConnectActions).toBe(false)
  })

  it("keeps Settings usable when the checkout target cannot be resolved", async () => {
    mocks.paymentsManaged = true
    mocks.findUnique.mockResolvedValue(settingsRow({ stripeAccountStatus: "active" }))
    setRuntimeExtensions([{
      id: "test-unavailable-checkout",
      resolveStripeCheckoutTarget: async () => { throw new Error("Checkout unavailable") },
    }])
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect((await createCaller().get()).stripePaymentsEnabled).toBe(false)
    expect(warn).toHaveBeenCalledWith("Settings could not resolve Stripe checkout target", { organizationId: "org-1" })
    warn.mockRestore()
  })

  it("warns and reports payments unavailable when stored keys cannot be decrypted", async () => {
    mocks.findUnique.mockResolvedValue(settingsRow({ stripeSecretKeyEnc: "invalid-ciphertext" }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await createCaller().get()
    expect(result.stripePaymentsEnabled).toBe(false)
    expect(result.stripeCheckoutKind).toBeNull()
    expect(warn).toHaveBeenCalledWith("Settings could not resolve Stripe checkout target", { organizationId: "org-1" })
    warn.mockRestore()
  })

  it("calls the registered Connect handler and does not persist the account", async () => {
    mocks.paymentsManaged = true
    const run = vi.fn(async () => ({ url: "https://connect.stripe.com/setup/s/test" }))
    setRuntimeServices({ stripeConnectSettings: { run } })

    await expect(createCaller().runStripeConnectAction({ action: "resume" })).resolves.toEqual({
      url: "https://connect.stripe.com/setup/s/test",
    })
    expect(run).toHaveBeenCalledWith("resume", { organizationId: "org-1" })
    expect(mocks.txUpsert).not.toHaveBeenCalled()

    run.mockResolvedValueOnce({ url: "http://example.test/insecure" })
    await expect(createCaller().runStripeConnectAction({ action: "connect" })).resolves.toEqual({
      url: null,
    })
  })

  it("refuses Connect actions when no handler is registered", async () => {
    mocks.paymentsManaged = true

    await expect(createCaller().runStripeConnectAction({ action: "disconnect" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Stripe Connect actions are not available",
    })
    expect(mocks.txUpsert).not.toHaveBeenCalled()
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

  it("refuses new or different Stripe key material when payments are managed", async () => {
    mocks.paymentsManaged = true

    await expect(createCaller().update(byokKeys)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Stripe keys cannot be saved while card payments are managed",
    })
    await expect(
      createCaller().update({ stripePublishableKey: "pk_test_different" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(
      createCaller().update({
        stripePublishableKey: "pk_test_123456789",
        stripeSecretKey: "sk_test_12345678901234567890",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(
      createCaller().update({ stripeWebhookSecret: "whsec_12345678901234567890" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect(mocks.txUpsert).not.toHaveBeenCalled()
  })

  it("rejects a new publishable key when a managed org has none stored", async () => {
    mocks.paymentsManaged = true
    mocks.txFindUnique.mockResolvedValue({
      countryCode: "DK",
      aiProvider: "openrouter",
      aiBaseUrl: null,
      momsRegistered: null,
      stripePublishableKey: null,
    })

    await expect(
      createCaller().update({ stripePublishableKey: "pk_test_123456789" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect(mocks.txUpsert).not.toHaveBeenCalled()
  })

  it("still saves other settings when payments are managed and secrets are omitted", async () => {
    mocks.paymentsManaged = true

    await createCaller().update({ companyName: "Managed Acme" })

    const update = mocks.txUpsert.mock.calls[0]?.[0].update
    expect(update.companyName).toBe("Managed Acme")
    expect(update.stripePublishableKey).toBeUndefined()
    expect(update.stripeSecretKeyEnc).toBeUndefined()
    expect(update.stripeWebhookSecretEnc).toBeUndefined()
  })

  it("saves unrelated settings when a managed org resubmits its stored publishable key", async () => {
    mocks.paymentsManaged = true

    await createCaller().update({
      companyName: "Managed Acme",
      stripePublishableKey: "pk_test_123456789",
      clearStripeSecretKey: false,
      clearStripeWebhookSecret: false,
    })

    const update = mocks.txUpsert.mock.calls[0]?.[0].update
    expect(update.companyName).toBe("Managed Acme")
    expect(update.stripePublishableKey).toBe("pk_test_123456789")
    expect(update.stripeSecretKeyEnc).toBeUndefined()
    expect(update.stripeWebhookSecretEnc).toBeUndefined()
  })

  it("clears stored Stripe secrets when payments are managed", async () => {
    mocks.paymentsManaged = true

    await createCaller().update({
      stripePublishableKey: "pk_test_123456789",
      clearStripeSecretKey: true,
      clearStripeWebhookSecret: true,
    })

    const update = mocks.txUpsert.mock.calls[0]?.[0].update
    expect(update.stripePublishableKey).toBe("pk_test_123456789")
    expect(update.stripeSecretKeyEnc).toBeNull()
    expect(update.stripeWebhookSecretEnc).toBeNull()
  })
})

afterEach(() => {
  resetRuntimeServices()
  setRuntimeExtensions([])
  vi.unstubAllEnvs()
})
