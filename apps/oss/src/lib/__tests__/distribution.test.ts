import { afterEach, describe, expect, it, vi } from "vitest"

function createPlatformEnv(env: Record<string, string | undefined>) {
  return {
    id: `test-${Math.random()}`,
    getRuntimeKind: () => "worker" as const,
    getEnv: (name: string) => env[name],
    getBinding: () => undefined,
    getPrisma: () => {
      throw new Error("distribution test should not request prisma")
    },
    getAuthHooks: () => ({}),
  }
}

describe("distribution flags", () => {
  afterEach(() => {
    vi.resetModules()
  })

  it("defaults to self-host with billing disabled", async () => {
    const mod = await import("../distribution")
    expect(mod.isSelfHostDistribution).toBe(true)
    expect(mod.isCloudDistribution).toBe(false)
    expect(mod.billingEnabled).toBe(false)
  })

  it("enables billing in cloud distribution by default", async () => {
    const { setRuntimePlatform } = await import("../runtime/platform")
    setRuntimePlatform(
      createPlatformEnv({
        QUITS_DISTRIBUTION: "cloud",
      })
    )
    const mod = await import("../distribution")
    expect(mod.isCloudDistribution).toBe(true)
    expect(mod.billingEnabled).toBe(true)
  })

  it("allows disabling billing in cloud distribution with env flag", async () => {
    const { setRuntimePlatform } = await import("../runtime/platform")
    setRuntimePlatform(
      createPlatformEnv({
        QUITS_DISTRIBUTION: "cloud",
        QUITS_BILLING_ENABLED: "false",
      })
    )
    const mod = await import("../distribution")
    expect(mod.billingEnabled).toBe(false)
  })

  it("enables oauth only when provider credentials are configured", async () => {
    let mod = await import("../distribution")
    expect(mod.oauthEnabled).toBe(false)

    vi.resetModules()
    const { setRuntimePlatform } = await import("../runtime/platform")
    setRuntimePlatform(
      createPlatformEnv({
        BETTER_AUTH_GOOGLE_CLIENT_ID: "google-id",
        BETTER_AUTH_GOOGLE_CLIENT_SECRET: "google-secret",
      })
    )
    mod = await import("../distribution")
    expect(mod.oauthEnabled).toBe(true)
  })
})
