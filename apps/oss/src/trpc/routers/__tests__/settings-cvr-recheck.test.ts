import { afterEach, describe, expect, it, vi } from "vitest"
import { TRPCError } from "@trpc/server"

// MOCK: a hosted server with in-memory persistence, an authenticated actor and a CVR registry
// that cannot be reached. The settings route itself is real.
const db = vi.hoisted(() => {
  const initialSettings = { companyName: "Testfirma ApS", companyAddress: "Testvej 1", countryCode: "DK",
    taxRegime: "eu_vat", momsRegistered: null as boolean | null, taxRate: 25, baseCurrency: "DKK", aiProvider: "openrouter", aiBaseUrl: null }
  // The legacy onboarding form stores the CVR under its default "vat" scheme, without a country.
  const initialIds = [{ id: "primary", scheme: "vat", value: "99000015", countryCode: null as string | null, isPrimary: true }]
  let settings = { ...initialSettings }
  let ids = structuredClone(initialIds)
  const tx = {
    $queryRaw: vi.fn(async () => [{ issued: false }]),
    orgSettings: {
      findUnique: async () => settings,
      findUniqueOrThrow: async () => settings,
      upsert: async ({ update }: { update: Partial<typeof settings> }) => (settings = { ...settings, ...update }),
      update: async ({ data }: { data: Partial<typeof settings> }) => (settings = { ...settings, ...data }),
    },
    organizationTaxId: {
      findMany: async () => [...ids],
      findFirst: async () => ids[0],
      updateMany: async () => ({ count: 0 }),
      update: async ({ where, data }: { where: { id: string }; data: Partial<typeof ids[number]> }) => {
        ids = ids.map(id => id.id === where.id ? { ...id, ...data } : id)
      },
    },
  }
  return {
    tx,
    reset: () => { settings = { ...initialSettings }; ids = structuredClone(initialIds) },
    settings: () => settings,
    ids: () => ids,
    transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => {
      const previousSettings = structuredClone(settings)
      const previousIds = structuredClone(ids)
      try { return await run(tx) }
      catch (error) { settings = previousSettings; ids = previousIds; throw error }
    }),
  }
})
const requireOnboardingCvr = vi.hoisted(() => vi.fn(async () => {
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: "cvr.unavailable" })
}))
vi.mock("../../../lib/db", () => ({ prisma: { ...db.tx, $transaction: db.transaction } }))
vi.mock("../../../lib/distribution", () => ({ isCloudDistribution: true, isSelfHostDistribution: false, billingEnabled: false, oauthEnabled: false }))
vi.mock("../../../lib/onboarding/require-cvr", () => ({ requireOnboardingCvr }))
vi.mock("../../init", async () => {
  const { initTRPC } = await import("@trpc/server")
  const t = initTRPC.create()
  const authenticated = t.procedure.use(({ next }) => next({ ctx: {
    organizationId: "org", user: { id: "user" }, session: { session: { id: "session" } },
  } }))
  return { router: t.router, publicProcedure: t.procedure, authorizedProcedure: () => authenticated }
})
import { settingsRouter } from "../settings"

afterEach(() => { db.reset(); vi.clearAllMocks() })

const settings = settingsRouter.createCaller({ session: null })

describe("hosted Settings CVR re-check", () => {
  it("saves a VAT answer when Settings files the stored number as a CVR, without a registry lookup", async () => {
    // Settings sends a Danish number with the "cvr" scheme, so the first save after the legacy
    // onboarding relabels it. The number itself was verified when onboarding stored it.
    await settings.update({ countryCode: "DK", primaryTaxId: "99000015", primaryTaxIdScheme: "cvr", momsRegistered: true })
    expect(requireOnboardingCvr).not.toHaveBeenCalled()
    expect(db.settings().momsRegistered).toBe(true)
    expect(db.ids()[0]).toMatchObject({ scheme: "cvr", value: "99000015", countryCode: "DK" })
  })

  it.each([
    ["a new number", { primaryTaxId: "12345674", primaryTaxIdScheme: "cvr" }],
    ["a scheme outside the Danish registrations", { primaryTaxId: "99000015", primaryTaxIdScheme: "other" }],
  ])("still checks %s with the registry", async (_change, edit) => {
    await expect(settings.update({ countryCode: "DK", ...edit, momsRegistered: true })).rejects.toMatchObject({ message: "cvr.unavailable" })
    expect(requireOnboardingCvr).toHaveBeenCalledTimes(1)
    expect(db.settings().momsRegistered).toBeNull()
    expect(db.ids()[0]).toMatchObject({ scheme: "vat", value: "99000015", countryCode: null })
  })
})
