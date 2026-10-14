import { afterEach, describe, expect, it, vi } from "vitest"

function createPlatformEnv(env: Record<string, string | undefined>) {
  return {
    id: `test-${Math.random()}`,
    getRuntimeKind: () => "worker" as const,
    getEnv: (name: string) => env[name],
    getBinding: () => undefined,
    getPrisma: () => {
      throw new Error("runtime extension test should not request prisma")
    },
    getAuthHooks: () => ({}),
  }
}

describe("runtime extension capabilities", () => {
  afterEach(() => {
    vi.resetModules()
  })

  it("preserves non-VAT onboarding through unrelated and partial patches, with explicit overrides", async () => {
    const mod = await import("../runtime/extensions")
    const optIn = { id: "onboarding", resolveCapabilities: () => ({ onboardingV2: { enabled: true, nonVatEnabled: true } }) }
    const unrelated = { id: "email", resolveCapabilities: () => ({ emailDelivery: { managed: true } }) }
    mod.setRuntimeExtensions([optIn, unrelated])
    const env = { QUITS_DISTRIBUTION: "cloud" }
    expect(mod.getRuntimeCapabilities(env)).toMatchObject({ onboardingV2: { enabled: true, nonVatEnabled: true }, emailDelivery: { managed: true } })
    mod.setRuntimeExtensions([optIn, unrelated, { id: "enabled-only", resolveCapabilities: () => ({ onboardingV2: { enabled: true } }) }])
    expect(mod.getRuntimeCapabilities(env).onboardingV2).toEqual({ enabled: true, nonVatEnabled: true })
    mod.setRuntimeExtensions([optIn, { id: "non-vat-off", resolveCapabilities: () => ({ onboardingV2: { nonVatEnabled: false } }) }, unrelated])
    expect(mod.getRuntimeCapabilities(env).onboardingV2).toEqual({ enabled: true, nonVatEnabled: false })
    mod.setRuntimeExtensions([optIn, { id: "onboarding-off", resolveCapabilities: () => ({ onboardingV2: { enabled: false } }) }, unrelated])
    expect(mod.getRuntimeCapabilities(env).onboardingV2).toEqual({ enabled: false, nonVatEnabled: true })
    expect(mod.getRuntimeCapabilities({}).onboardingV2).toEqual({ enabled: false, nonVatEnabled: false })
  })

  it("keeps deposits enabled by default and lets a runtime extension disable only deposits", async () => {
    const mod = await import("../runtime/extensions")
    const baseline = mod.getRuntimeCapabilities({})
    expect(baseline.agreements.depositsEnabled).toBe(true)
    expect(mod.getRuntimeCapabilities({ QUITS_DISTRIBUTION: "cloud" }).agreements.depositsEnabled).toBe(true)
    expect(mod.getRuntimeCapabilities({ QUITS_DEPOSITS_ENABLED: "false" }).agreements.depositsEnabled).toBe(false)
    expect(mod.getRuntimeCapabilities({ YAIP_DEPOSITS_ENABLED: "false" }).agreements.depositsEnabled).toBe(false)
    expect(mod.getRuntimeCapabilities({ QUITS_DEPOSITS_ENABLED: "true", YAIP_DEPOSITS_ENABLED: "false" }).agreements.depositsEnabled).toBe(true)
    mod.setRuntimeExtensions([{ id: "disable-deposits", resolveCapabilities: () => ({ agreements: { depositsEnabled: false } }) }])
    expect(mod.getRuntimeCapabilities({})).toEqual({ ...baseline, agreements: { depositsEnabled: false } })
    mod.setRuntimeExtensions([])
    expect(mod.getRuntimeCapabilities({})).toEqual(baseline)
  })

  it("keeps seller VAT confirmation off by default and prevents a self-hosted extension gate", async () => {
    const mod = await import("../runtime/extensions")
    expect(mod.getRuntimeCapabilities({ QUITS_DISTRIBUTION: "cloud" }).sellerVatConfirmation.enabled).toBe(false)
    mod.setRuntimeExtensions([{ id: "seller-confirmation", resolveCapabilities: () => ({ sellerVatConfirmation: { enabled: true } }) }])
    expect(mod.getRuntimeCapabilities({ QUITS_DISTRIBUTION: "cloud" }).sellerVatConfirmation.enabled).toBe(true)
    expect(mod.getRuntimeCapabilities({ QUITS_DISTRIBUTION: "selfhost" }).sellerVatConfirmation.enabled).toBe(false)
    expect(mod.getRuntimeCapabilities({}).sellerVatConfirmation.enabled).toBe(false)
  })

  it("defaults to BYOK AI enabled and managed disabled", async () => {
    const mod = await import("../runtime/extensions")
    const caps = mod.getRuntimeCapabilities()

    expect(caps.aiInvoiceDraft.enabled).toBe(true)
    expect(caps.aiInvoiceDraft.byok).toBe(true)
    expect(caps.aiInvoiceDraft.managed).toBe(false)
    expect(caps.onboardingAi.enabled).toBe(false)
    expect(caps.emailDelivery.enabled).toBe(true)
    expect(caps.emailDelivery.managed).toBe(false)
  })

  it("allows private extension to enable managed AI", async () => {
    const mod = await import("../runtime/extensions")

    mod.setRuntimeExtensions([
      {
        id: "cloud-managed-ai",
        resolveCapabilities: () => ({
          aiInvoiceDraft: {
            managed: true,
            managedRequiresSubscription: true,
          },
        }),
      },
    ])

    const caps = mod.getRuntimeCapabilities()
    expect(caps.aiInvoiceDraft.managed).toBe(true)
    expect(caps.aiInvoiceDraft.managedRequiresSubscription).toBe(true)
  })

  it("enables drafting when an extension turns on managed AI over a disabled base", async () => {
    const mod = await import("../runtime/extensions")
    mod.setRuntimeExtensions([
      {
        id: "cloud-managed-ai",
        resolveCapabilities: () => ({ aiInvoiceDraft: { managed: true } }),
      },
    ])

    const caps = mod.getRuntimeCapabilities({ QUITS_AI_BYOK_ENABLED: "false" })
    expect(caps.aiInvoiceDraft.enabled).toBe(true)
  })

  it("lets an extension switch drafting off explicitly", async () => {
    const mod = await import("../runtime/extensions")
    mod.setRuntimeExtensions([
      { id: "no-ai", resolveCapabilities: () => ({ aiInvoiceDraft: { enabled: false } }) },
    ])

    expect(mod.getRuntimeCapabilities({}).aiInvoiceDraft.enabled).toBe(false)
  })

  it("honours a later extension that switches drafting back on", async () => {
    const mod = await import("../runtime/extensions")
    mod.setRuntimeExtensions([
      { id: "off", resolveCapabilities: () => ({ aiInvoiceDraft: { enabled: false } }) },
      { id: "on", resolveCapabilities: () => ({ aiInvoiceDraft: { enabled: true } }) },
    ])

    expect(mod.getRuntimeCapabilities({}).aiInvoiceDraft.enabled).toBe(true)
  })

  it("never offers the local agent on a worker runtime", async () => {
    const { setRuntimePlatform } = await import("../runtime/platform")
    setRuntimePlatform(
      createPlatformEnv({
        QUITS_AI_LOCAL_AGENT_ENABLED: "true",
        QUITS_AI_LOCAL_AGENT_COMMAND: "claude -p",
      })
    )

    const mod = await import("../runtime/extensions")
    expect(mod.getRuntimeCapabilities().aiInvoiceDraft.localAgent).toBe(false)
  })

  it("supports replacing extension list at runtime", async () => {
    const mod = await import("../runtime/extensions")

    mod.setRuntimeExtensions([
      {
        id: "disable-byok",
        resolveCapabilities: () => ({
          aiInvoiceDraft: {
            byok: false,
          },
        }),
      },
    ])

    expect(mod.getRuntimeCapabilities().aiInvoiceDraft.byok).toBe(false)

    mod.setRuntimeExtensions([])
    expect(mod.getRuntimeCapabilities().aiInvoiceDraft.byok).toBe(true)
  })

  it("reads managed capability defaults from the active runtime platform", async () => {
    const { setRuntimePlatform } = await import("../runtime/platform")
    setRuntimePlatform(
      createPlatformEnv({
        QUITS_DISTRIBUTION: "cloud",
        QUITS_AI_BYOK_ENABLED: "false",
        QUITS_AI_MANAGED_ENABLED: "true",
      })
    )

    const mod = await import("../runtime/extensions")
    const caps = mod.getRuntimeCapabilities()

    expect(caps.aiInvoiceDraft.byok).toBe(false)
    expect(caps.aiInvoiceDraft.managed).toBe(true)
    expect(caps.aiInvoiceDraft.enabled).toBe(true)
  })

  it("allows custom endpoints on self-host and not on cloud", async () => {
    const mod = await import("../runtime/extensions")

    expect(mod.getRuntimeCapabilities({}).aiInvoiceDraft.customEndpoint).toBe(true)
    expect(
      mod.getRuntimeCapabilities({ QUITS_DISTRIBUTION: "cloud" }).aiInvoiceDraft.customEndpoint
    ).toBe(false)
  })

  it("enables the local agent only with both the flag and a command, never on cloud", async () => {
    const mod = await import("../runtime/extensions")

    expect(mod.getRuntimeCapabilities({}).aiInvoiceDraft.localAgent).toBe(false)
    expect(
      mod.getRuntimeCapabilities({ QUITS_AI_LOCAL_AGENT_ENABLED: "true" }).aiInvoiceDraft.localAgent
    ).toBe(false)
    expect(
      mod.getRuntimeCapabilities({ QUITS_AI_LOCAL_AGENT_COMMAND: "claude -p" }).aiInvoiceDraft
        .localAgent
    ).toBe(false)
    expect(
      mod.getRuntimeCapabilities({
        QUITS_AI_LOCAL_AGENT_ENABLED: "true",
        QUITS_AI_LOCAL_AGENT_COMMAND: "claude -p",
      }).aiInvoiceDraft.localAgent
    ).toBe(true)
    expect(
      mod.getRuntimeCapabilities({
        QUITS_DISTRIBUTION: "cloud",
        QUITS_AI_LOCAL_AGENT_ENABLED: "true",
        QUITS_AI_LOCAL_AGENT_COMMAND: "claude -p",
      }).aiInvoiceDraft.localAgent
    ).toBe(false)
  })
})
