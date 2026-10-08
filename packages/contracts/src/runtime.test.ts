import { describe, expect, it } from "vitest"
import {
  runtimeCapabilitiesSchema,
  runtimeCapabilityPatchSchema,
} from "./runtime"

describe("runtime contracts", () => {
  it("parses runtime capabilities", () => {
    const parsed = runtimeCapabilitiesSchema.parse({
      documents: { artifactsRequired: false },
      aiInvoiceDraft: {
        enabled: true,
        byok: true,
        managed: false,
        managedRequiresSubscription: false,
        customEndpoint: true,
        localAgent: false,
        maxPromptChars: 4000,
      },
      onboardingAi: {
        enabled: true,
        managed: true,
      },
      payments: {
        enabled: true,
        managed: false,
        provider: "stripe",
      },
      emailDelivery: {
        enabled: true,
        managed: false,
      },
    })

    expect(parsed.payments.provider).toBe("stripe")
  })

  it("rejects invalid payment providers in capability patches", () => {
    const parsed = runtimeCapabilityPatchSchema.safeParse({
      payments: {
        provider: "paypal",
      },
    })

    expect(parsed.success).toBe(false)
  })
})
