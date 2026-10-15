import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Context } from "../../init"
import { onboardingAiRouter } from "../onboarding-ai"

const db = vi.hoisted(() => ({
  orgSettings: {
    createMany: vi.fn(async () => ({ count: 0 })),
    findUniqueOrThrow: vi.fn(),
  },
  organizationTaxId: {
    findFirst: vi.fn(async () => ({ value: "DK24256790", scheme: "vat" })),
  },
}))

vi.mock("../../../lib/db", () => ({ prisma: db }))
vi.mock("../../../lib/distribution", () => ({ isCloudDistribution: true }))
vi.mock("../../../lib/runtime/extensions", () => ({
  getRuntimeCapabilities: () => ({ onboardingAi: { enabled: true } }),
}))
vi.mock("../../init", async () => {
  const { initTRPC } = await import("@trpc/server")
  const t = initTRPC.context<Context>().create()
  const procedure = t.procedure.use(({ next }) =>
    next({ ctx: { organizationId: "org-readiness" } })
  )
  return { router: t.router, authorizedProcedure: () => procedure }
})

describe("onboarding AI snapshot readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    { version: 2, missing: [] },
    { version: 1, missing: ["companyEmail"] },
    { version: null, missing: ["companyEmail"] },
  ])("uses saved version $version when companyEmail is null", async ({ version, missing }) => {
    db.orgSettings.findUniqueOrThrow.mockResolvedValue({
      onboardingStatus: "complete",
      onboardingMethod: "manual",
      onboardingProfile: "smb",
      onboardingInvoicingIdentity: "registered_business",
      onboardingVersion: version,
      onboardingCompletedAt: new Date("2026-10-01T00:00:00Z"),
      countryCode: "DK",
      locale: "da-DK",
      timezone: "Europe/Copenhagen",
      defaultCurrency: "DKK",
      taxRegime: "eu_vat",
      pricesIncludeTax: false,
      companyName: "Test ApS",
      companyAddress: "Testvej 1, 1000 København",
      companyEmail: null,
      invoicePrefix: "INV",
      invoiceNextNum: 1,
      quotePrefix: "QTE",
      quoteNextNum: 1,
    })
    const caller = onboardingAiRouter.createCaller({ session: null })

    const state = await caller.getOnboardingState()

    expect(state.status).toBe("complete")
    expect(state.values.companyEmail).toBeNull()
    expect(state.missing).toEqual(missing)
  })
})
