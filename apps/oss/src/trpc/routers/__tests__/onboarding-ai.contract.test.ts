import "dotenv/config"
import { randomUUID } from "node:crypto"
import { TRPCError } from "@trpc/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../../../lib/db"
import { ensureTestMembership } from "../../../test-utils/membership"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip

type CallerLike = {
  onboardingAi: {
    getOnboardingState: () => Promise<{
      status: string
      missing: string[]
      values: Record<string, unknown>
    }>
    getRequirementRules: (input: {
      countryCode: string
      taxRegime: "us_sales_tax" | "eu_vat" | "custom"
    }) => Promise<{
      requiredFields: string[]
      optionalFields: string[]
    }>
    suggestOnboardingPatch: (input: {
      userMessage: string
      currentValues?: Record<string, unknown>
      missing?: string[]
      rules?: Record<string, unknown>
    }) => Promise<{
      patch: Record<string, unknown>
      rationale: string
      confidence: number
      followupQuestions: string[]
    }>
    applyOnboardingPatch: (input: {
      patch: Record<string, unknown>
      source: "ai" | "manual"
    }) => Promise<{
      isComplete: boolean
      missing: string[]
      values: Record<string, unknown>
    }>
    validateOnboardingReadiness: (input: {
      values: Record<string, unknown>
    }) => Promise<{
      isComplete: boolean
      missing: string[]
      blockingReasons: string[]
    }>
    listFollowupQuestions: (input: {
      missing: string[]
      values?: Record<string, unknown>
      rules?: Record<string, unknown>
    }) => Promise<{
      questions: Array<{
        id: string
        question: string
        fieldHint: string
      }>
    }>
  }
}

async function createCaller(distribution: "cloud" | "selfhost", orgId: string) {
  vi.resetModules()
  process.env.YAIP_DISTRIBUTION = distribution
  const { appRouter } = await import("../../router")

  return appRouter.createCaller({
    session: {
      user: {
        id: "onboarding-ai-user",
        email: "onboarding-ai@example.com",
        name: "Onboarding AI User",
      },
      session: {
        activeOrganizationId: orgId,
      },
    },
  } as never) as unknown as CallerLike
}

describeIfDatabase("onboarding ai contract", () => {
  afterEach(async () => {
    process.env.YAIP_DISTRIBUTION = "selfhost"
    const runtimeServices = await import("../../../lib/runtime/services")
    runtimeServices.resetRuntimeServices()
    vi.resetModules()
  })

  it("blocks onboarding ai contract methods in selfhost distribution", async () => {
    const caller = await createCaller("selfhost", "org-selfhost")

    await expect(caller.onboardingAi.getOnboardingState()).rejects.toMatchObject({
      code: "FORBIDDEN",
    } satisfies Partial<TRPCError>)
  })

  it("exposes cloud onboarding ai operations and applies suggested patches", async () => {
    const orgId = randomUUID()
    const slug = `onboarding-ai-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`

    await prisma.organization.create({
      data: {
        id: orgId,
        name: "Onboarding AI Org",
        slug,
        createdAt: new Date(),
        subscriptionStatus: "pro",
      },
    })
    await ensureTestMembership(orgId, "onboarding-ai-user")

    try {
      const caller = await createCaller("cloud", orgId)
      const runtimeServices = await import("../../../lib/runtime/services")
      runtimeServices.setRuntimeServices({
        onboardingAiService: {
          suggestPatch: async () => ({
            patch: {
              companyName: "Acme Cloud",
              companyEmail: "billing@acme.example",
              countryCode: "DK",
              locale: "da-DK",
              timezone: "Europe/Copenhagen",
              defaultCurrency: "DKK",
              taxRegime: "eu_vat",
              primaryTaxId: "DK12345678",
              primaryTaxIdScheme: "DK_VAT",
              invoicePrefix: "INV",
              quotePrefix: "QTE",
            },
            rationale: "User asked for Denmark + VAT setup.",
            confidence: 0.91,
            followupQuestions: [],
          }),
        },
      })

      const state = await caller.onboardingAi.getOnboardingState()
      expect(state.status).toBe("not_started")
      expect(state.missing).toContain("companyName")

      const rules = await caller.onboardingAi.getRequirementRules({
        countryCode: "DK",
        taxRegime: "eu_vat",
      })
      expect(rules.requiredFields).toContain("primaryTaxId")

      const suggestion = await caller.onboardingAi.suggestOnboardingPatch({
        userMessage: "We are in Denmark and need VAT invoices.",
        currentValues: {
          ...state.values,
          companyEmail: "",
        },
        missing: state.missing,
      })
      expect(suggestion.patch.companyName).toBe("Acme Cloud")

      const applied = await caller.onboardingAi.applyOnboardingPatch({
        source: "ai",
        patch: suggestion.patch,
      })
      expect(applied.values.companyName).toBe("Acme Cloud")
      expect(applied.missing).toContain("companyAddress")

      const validated = await caller.onboardingAi.validateOnboardingReadiness({
        values: applied.values,
      })
      expect(validated.isComplete).toBe(false)
      expect(validated.blockingReasons.length).toBeGreaterThan(0)

      const followups = await caller.onboardingAi.listFollowupQuestions({
        missing: validated.missing,
        values: applied.values,
      })
      expect(followups.questions.length).toBeGreaterThan(0)
    } finally {
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })
})
