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
