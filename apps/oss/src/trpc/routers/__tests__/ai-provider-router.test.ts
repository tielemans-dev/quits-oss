import { beforeEach, describe, expect, it, vi } from "vitest"
import { FALLBACK_AI_MODELS } from "../../../lib/ai/invoice-draft"
import { aiRouter } from "../ai"
import { settingsRouter } from "../settings"
import { resetRuntimeServices, setRuntimeServices } from "../../../lib/runtime/services"

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  txFindUnique: vi.fn(),
  decryptSecret: vi.fn(),
  aiCapabilities: {} as Record<string, unknown>,
}))

vi.mock("../../../lib/db", () => ({
  prisma: {
    orgSettings: { findUnique: mocks.findUnique },
    contact: { findMany: mocks.findMany },
    catalogItem: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (run: (tx: unknown) => unknown) =>
      run({ orgSettings: { findUnique: mocks.txFindUnique } })
    ),
  },
}))

vi.mock("../../../domain/documents/base-currency", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../domain/documents/base-currency")>()),
  resolveBaseCurrency: async () => "EUR",
}))

vi.mock("../../../lib/secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/secrets")>()),
  decryptSecret: mocks.decryptSecret,
}))

vi.mock("../../../domain/actor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../domain/actor")>()),
  actorCan: () => true,
}))

vi.mock("../../../domain/user-actor", () => ({
  resolveUserActor: async () => ({ userId: "user-1", role: "owner" }),
}))

vi.mock("../../../lib/runtime/extensions", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../lib/runtime/extensions")>()
  return {
    ...original,
    getRuntimeCapabilities: () => ({
      ...original.getRuntimeCapabilities({}),
      aiInvoiceDraft: mocks.aiCapabilities,
    }),
  }
})

const defaultAiCapabilities = {
  enabled: true,
  byok: true,
  managed: false,
  managedRequiresSubscription: false,
  customEndpoint: true,
  localAgent: false,
  maxPromptChars: 4000,
}

function createContext() {
  return {
    session: {
      user: { id: "user-1", name: "Test User", email: "test@example.com" },
      session: { activeOrganizationId: "org-1" },
    },
    requestedOrganizationId: null,
  } as never
}

describe("ai router provider handling", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.aiCapabilities = { ...defaultAiCapabilities }
  })

  it("lists fallback models with the current model when the organisation has no key", async () => {
    mocks.findUnique.mockResolvedValue({
      aiProvider: "openrouter",
      aiBaseUrl: null,
      aiApiKeyEnc: null,
      aiModel: "acme/custom-model",
    })

    const caller = aiRouter.createCaller(createContext())
    const result = await caller.listModels()

    expect(result.source).toBe("fallback")
    expect(result.models).toEqual(
      Array.from(new Set([...FALLBACK_AI_MODELS, "acme/custom-model"]))
    )
  })

  it("lists no models for a CLI agent, which chooses its own model", async () => {
    mocks.findUnique.mockResolvedValue({
      aiProvider: "cli_agent",
      aiBaseUrl: null,
      aiApiKeyEnc: null,
      aiModel: null,
    })

    const caller = aiRouter.createCaller(createContext())
    expect(await caller.listModels()).toEqual({ models: [], source: "none" })
  })

  it("maps a disabled provider to PRECONDITION_FAILED when drafting", async () => {
    mocks.aiCapabilities = { ...defaultAiCapabilities, byok: false }
    mocks.findUnique.mockResolvedValue({
      aiProvider: "openrouter",
      aiBaseUrl: null,
      aiApiKeyEnc: "encrypted-key",
      aiModel: null,
    })
    mocks.decryptSecret.mockReturnValue("sk-test-key")

    const caller = aiRouter.createCaller(createContext())
    await expect(
      caller.generateInvoiceDraft({ prompt: "Invoice Acme for three hours of consulting" })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
  })
})

describe("managed AI", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRuntimeServices()
  })

  it("refuses managed drafting without an active subscription when one is required", async () => {
    const complete = vi.fn()
    mocks.aiCapabilities = {
      ...defaultAiCapabilities,
      byok: false,
      managed: true,
      managedRequiresSubscription: true,
    }
    mocks.findUnique.mockResolvedValue({ aiModel: null })
    setRuntimeServices({
      managedAiProvider: { id: "managed", complete },
      billingProvider: {
        getSubscription: async () => ({ status: "past_due", priceId: null }),
        assertInvoiceCreationAllowed: async () => {},
      },
    })

    const caller = aiRouter.createCaller(createContext())
    await expect(
      caller.generateInvoiceDraft({
        prompt: "Invoice Acme for three hours of consulting",
        mode: "managed",
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
    expect(complete).not.toHaveBeenCalled()
    resetRuntimeServices()
  })
})

describe("provider fallbacks and errors", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRuntimeServices()
  })

  it("uses managed AI when the organisation has not configured its own provider", async () => {
    const complete = vi.fn(async () => '{"items":[{"description":"Consulting","quantity":3}]}')
    mocks.aiCapabilities = { ...defaultAiCapabilities, managed: true }
    mocks.findMany.mockResolvedValue([])
    mocks.findUnique.mockResolvedValue({
      aiProvider: "openrouter",
      aiBaseUrl: null,
      aiApiKeyEnc: null,
      aiModel: "llama3.2",
    })
    setRuntimeServices({
      managedAiProvider: { id: "managed", complete, defaultModel: "hosted/default" },
    })

    const caller = aiRouter.createCaller(createContext())
    const result = await caller.generateInvoiceDraft({
      prompt: "Invoice Acme for three hours of consulting",
    })

    expect(result.provider).toBe("managed")
    // The saved model belongs to the organisation's own provider; managed AI uses its own.
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: "hosted/default" }))
    resetRuntimeServices()
  })

  it("does not pass upstream error details to the client", async () => {
    const { AiProviderError } = await import("../../../lib/ai/provider")
    const complete = vi.fn(async () => {
      throw new AiProviderError({
        code: "http",
        providerId: "managed",
        message: "AI endpoint failed (500): internal stack at /srv/secret/path",
      })
    })
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.aiCapabilities = { ...defaultAiCapabilities, byok: false, managed: true }
    mocks.findMany.mockResolvedValue([])
    mocks.findUnique.mockResolvedValue({ aiModel: null })
    setRuntimeServices({ managedAiProvider: { id: "managed", complete } })

    const caller = aiRouter.createCaller(createContext())
    const error = await caller
      .generateInvoiceDraft({ prompt: "Invoice Acme for three hours", mode: "managed" })
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: "BAD_GATEWAY", message: "The AI provider request failed" })
    resetRuntimeServices()
  })
})

describe("settings router AI provider handling", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.aiCapabilities = { ...defaultAiCapabilities }
  })

  it("rejects switching to the local agent when the runtime does not enable it", async () => {
    mocks.txFindUnique.mockResolvedValue({
      countryCode: "DK",
      aiProvider: "openrouter",
      aiBaseUrl: null,
    })
    const caller = settingsRouter.createCaller(createContext())

    await expect(caller.update({ aiProvider: "cli_agent" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
  })
})
