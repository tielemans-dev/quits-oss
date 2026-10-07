import { afterEach, describe, expect, it } from "vitest"

import {
  bootstrapQuitsRuntime,
  resetQuitsRuntimeForTests,
} from "../runtime/bootstrap"
import { getRuntimeCapabilities, getRuntimeExtensions } from "../runtime/extensions"
import {
  getManagedDocumentDomainProvider,
  getOnboardingAiService,
} from "../runtime/services"
import { getRuntimePlatform, type RuntimePlatform } from "../runtime/platform"

function createFakePlatform(id: string): RuntimePlatform {
  return {
    id,
    getRuntimeKind: () => "worker",
    getEnv: () => undefined,
    getBinding: () => undefined,
    getPrisma: () => {
      throw new Error("runtime bootstrap test should not request prisma")
    },
    getAuthHooks: () => ({}),
  }
}

describe("runtime bootstrap", () => {
  afterEach(() => {
    resetQuitsRuntimeForTests()
  })

  it("installs platform, extensions, and services together", async () => {
    const platform = createFakePlatform("cloud-bootstrap")

    bootstrapQuitsRuntime({
      platform,
      extensions: [
        {
          id: "managed-email",
          resolveCapabilities: () => ({
            emailDelivery: {
              managed: true,
            },
          }),
        },
      ],
      services: {
        onboardingAiService: {
          suggestPatch: async () => ({
            patch: {},
            rationale: "ok",
            confidence: 1,
            followupQuestions: [],
          }),
        },
        managedDocumentDomainProvider: {
          supported: true,
          createDomain: async () => {
            throw new Error("unused")
          },
          refreshDomain: async () => {
            throw new Error("unused")
          },
          deleteDomain: async () => {},
        },
      },
    })

    expect(getRuntimePlatform()).toBe(platform)
    expect(getRuntimeExtensions()).toHaveLength(1)
    expect(getRuntimeCapabilities().emailDelivery.managed).toBe(true)
    expect(getManagedDocumentDomainProvider().supported).toBe(true)
    expect(typeof getOnboardingAiService().suggestPatch).toBe("function")
  })
})
