import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TRPCError } from "@trpc/server"
import type { SellerSnapshot } from "@quits/contracts/documents"
import { setRuntimeExtensions } from "../../../lib/runtime/extensions"

// MOCK: in-memory persistence and an authenticated actor. Both route handlers,
// capability checks, identity projection and prepare/confirm calls remain real.
const db = vi.hoisted(() => {
  const initialSettings = { companyName: "Original seller", companyAddress: "Testvej 1", countryCode: "DK",
    taxRegime: "eu_vat", momsRegistered: true, taxRate: 25, baseCurrency: "DKK", aiProvider: "openrouter", aiBaseUrl: null }
  const initialIds = [
    { id: "primary", scheme: "vat", value: "12345678", countryCode: null, isPrimary: true },
    { id: "other", scheme: "lei", value: "OTHER-ID", countryCode: "DK", isPrimary: false },
  ]
  let settings = { ...initialSettings }
  let ids = structuredClone(initialIds)
  const tx = {
    $queryRaw: vi.fn(async () => [{ issued: false }]),
    orgSettings: {
      findUnique: async () => settings,
      findUniqueOrThrow: async () => settings,
      upsert: async ({ update }: { update: Partial<typeof settings> }) => (settings = { ...settings, ...update }),
    },
    organizationTaxId: {
      findMany: async () => ids,
      findFirst: async () => ids[0],
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
vi.mock("../../../lib/db", () => ({ prisma: { ...db.tx, $transaction: db.transaction } }))
vi.mock("../../../lib/runtime/company-lookup", () => ({ lookupOnboardingCompany: vi.fn() }))
vi.mock("../../init", async () => {
  const { initTRPC } = await import("@trpc/server")
  const t = initTRPC.create()
  const authenticated = t.procedure.use(({ next }) => next({ ctx: {
    organizationId: "org", user: { id: "user" }, session: { session: { id: "session" } },
  } }))
  return { router: t.router, publicProcedure: t.procedure, authorizedProcedure: () => authenticated }
})
import { runtimeRouter } from "../runtime"
import { settingsRouter } from "../settings"

const identity = (seller: SellerSnapshot) => JSON.stringify([seller.companyName, seller.companyAddress, seller.countryCode,
  seller.taxIds?.map(id => [id.scheme, id.value, id.countryCode ?? null]).sort()])
const confirm = vi.fn(async ({ seller, token }: { seller: SellerSnapshot; token: string }) => {
  if (identity(seller) !== token) throw new TRPCError({ code: "CONFLICT", message: "Identity changed" })
})
function hosted(nonVatEnabled: boolean) {
  setRuntimeExtensions([{ id: "synthetic-binding", resolveCapabilities: () => ({
    onboardingV2: { nonVatEnabled }, sellerVatConfirmation: { enabled: true },
  }), sellerVatConfirmation: { prepare: async ({ seller }) => ({ token: identity(seller) }), confirm } }])
}
beforeEach(() => { db.reset(); vi.stubEnv("QUITS_DISTRIBUTION", "cloud") })
afterEach(() => { setRuntimeExtensions([]); vi.unstubAllEnvs(); vi.clearAllMocks() })

const runtime = runtimeRouter.createCaller({ session: null })
const settings = settingsRouter.createCaller({ session: null })
const input = { companyName: "Reviewed seller", companyAddress: "Testvej 2", countryCode: "DK" as const, cvr: "24256790" }
describe("hosted Settings prepare/save capability boundary", () => {
  it.each([{ taxRegime: "custom" as const }, { countryCode: "US" }])("rejects an unconfirmed retained choice on Danish VAT entry from %j", async outside => {
    hosted(true)
    await settings.update({ ...outside, momsRegistered: false })
    await expect(settings.update({ countryCode: "DK", taxRegime: "eu_vat" })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect(db.settings()).toMatchObject({ ...outside, momsRegistered: false })
    expect(confirm).not.toHaveBeenCalled()
  })
  it.each([true, false])("reconfirms retained %s on context entry without discarding a genuine choice", async registered => {
    hosted(true)
    const prepared = await runtime.prepareSellerVatConfirmation({ companyName: db.settings().companyName,
      companyAddress: db.settings().companyAddress, countryCode: "DK", cvr: db.ids()[0]!.value, primaryTaxIdScheme: "vat" })
    await settings.update({ momsRegistered: registered, sellerVatConfirmationToken: prepared.token })
    await settings.update({ taxRegime: "custom" })
    await expect(settings.update({ taxRegime: "eu_vat" })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect(db.settings()).toMatchObject({ taxRegime: "custom", momsRegistered: registered })
    await expect(settings.update({ taxRegime: "eu_vat", companyName: "Unreviewed identity", sellerVatConfirmationToken: prepared.token })).rejects.toMatchObject({ code: "CONFLICT" })
    expect(db.settings()).toMatchObject({ taxRegime: "custom", companyName: "Original seller", momsRegistered: registered })
    await settings.update({ taxRegime: "eu_vat", sellerVatConfirmationToken: prepared.token })
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ registered }))
    expect(db.settings()).toMatchObject({ taxRegime: "eu_vat", momsRegistered: registered })
  })
  it("allows unknown status on entry without granting a confirmed choice", async () => {
    hosted(true)
    await settings.update({ taxRegime: "custom", momsRegistered: null })
    await settings.update({ taxRegime: "eu_vat" })
    expect(db.settings()).toMatchObject({ taxRegime: "eu_vat", momsRegistered: null })
    expect(confirm).not.toHaveBeenCalled()
  })
  it("does not add a context-entry gate for self-hosted settings", async () => {
    hosted(true); vi.stubEnv("QUITS_DISTRIBUTION", "selfhost")
    await settings.update({ taxRegime: "custom", momsRegistered: false })
    await settings.update({ taxRegime: "eu_vat" })
    expect(db.settings()).toMatchObject({ taxRegime: "eu_vat", momsRegistered: false })
    expect(confirm).not.toHaveBeenCalled()
  })
  it("allows unrelated hosted saves without reconfirmation", async () => {
    hosted(true)
    await settings.update({ companyEmail: "seller@example.test" })
    expect(confirm).not.toHaveBeenCalled()
  })
  it("rejects non-registration before any write when only confirmation is enabled", async () => {
    hosted(false)
    const prepared = await runtime.prepareSellerVatConfirmation({ ...input, primaryTaxIdScheme: "vat" })
    await expect(settings.update({ momsRegistered: false, sellerVatConfirmationToken: prepared.token })).rejects.toMatchObject({ code: "FORBIDDEN", message: "save.failed" })
    expect(db.transaction).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })
  it.each(["vat", "cvr", "DK_CVR"])("saves the prepared %s identity and rolls back stale-token edits", async primaryTaxIdScheme => {
    hosted(true)
    const prepared = await runtime.prepareSellerVatConfirmation({ ...input, primaryTaxIdScheme })
    await settings.update({ companyName: input.companyName, companyAddress: input.companyAddress, countryCode: input.countryCode,
      primaryTaxId: input.cvr, primaryTaxIdScheme, momsRegistered: false, sellerVatConfirmationToken: prepared.token })
    expect(db.settings()).toMatchObject({ companyName: input.companyName, momsRegistered: false, taxRate: 0 })
    expect(db.ids()).toEqual([
      { id: "primary", scheme: primaryTaxIdScheme, value: input.cvr, countryCode: null, isPrimary: true },
      { id: "other", scheme: "lei", value: "OTHER-ID", countryCode: "DK", isPrimary: false },
    ])
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org", userId: "user", sessionId: "session", registered: false, token: prepared.token }))
    await expect(settings.update({ companyName: "Unreviewed seller", momsRegistered: true, sellerVatConfirmationToken: prepared.token })).rejects.toMatchObject({ code: "CONFLICT" })
    expect(db.settings()).toMatchObject({ companyName: input.companyName, momsRegistered: false, taxRate: 0 })
  })
  it("still requires preparation when non-registration is enabled", async () => {
    hosted(true)
    await expect(settings.update({ momsRegistered: false })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Choose and confirm seller VAT status" })
    expect(db.settings()).toMatchObject({ momsRegistered: true, taxRate: 25 })
    expect(confirm).not.toHaveBeenCalled()
  })
})
