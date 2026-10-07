import { describe, expect, it, vi } from "vitest"

import { buildQuitsAuthOptions } from "../runtime/auth-config"

describe("auth runtime platform", () => {
  it("uses the provided env reader and auth hooks", () => {
    const fakeAdapter = { type: "custom-adapter" }

    const options = buildQuitsAuthOptions({
      prisma: {
        orgSettings: {
          findUnique: vi.fn(),
        },
      } as never,
      env: {
        getEnv(name) {
          return {
            BETTER_AUTH_URL: "https://app.yaip.example/login",
            QUITS_SHELL_ORIGIN: "https://yaip.example",
            QUITS_APP_ORIGIN: "https://app.yaip.example/dashboard",
            QUITS_DISTRIBUTION: "cloud",
            QUITS_AUTH_COOKIE_DOMAIN: "yaip.example",
          }[name]
        },
      },
      hooks: {
        createDatabaseAdapter: () => fakeAdapter,
      },
    })

    expect(options.database).toBe(fakeAdapter)
    expect(options.trustedOrigins).toEqual([
      "https://app.yaip.example",
      "https://yaip.example",
    ])
    expect(options.advanced?.crossSubDomainCookies).toEqual({
      enabled: true,
      domain: "yaip.example",
    })
  })
})
