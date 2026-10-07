import { afterEach, describe, expect, it, vi } from "vitest"

const fakePrisma = { marker: "worker-prisma" }

describe("db runtime platform", () => {
  afterEach(async () => {
    const { resetRuntimePlatform } = await import("../runtime/platform")
    resetRuntimePlatform()
    vi.resetModules()
  })

  it("reads prisma from the active runtime platform", async () => {
    const { setRuntimePlatform } = await import("../runtime/platform")

    setRuntimePlatform({
      id: "worker-test",
      getRuntimeKind: () => "worker",
      getEnv: () => undefined,
      getBinding: () => undefined,
      getPrisma: () => fakePrisma,
      getAuthHooks: () => ({}),
    })

    const mod = await import("../db")

    expect(mod.getPrisma()).toBe(fakePrisma)
    expect((mod.prisma as unknown as { marker: string }).marker).toBe("worker-prisma")
  })
})
