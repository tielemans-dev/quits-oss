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
  let selectedReads = 0
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
      findMany: async ({ select }: { select?: object }) => {
        // Equal createdAt ties can arrive in different order on preparation and confirmation.
        const rows = select && selectedReads++ % 2 ? [...ids].reverse() : [...ids]
        const ordered = rows.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
        return select ? ordered.map(({ scheme, value, countryCode }) => ({ scheme, value, countryCode })) : ordered
      },
      findFirst: async () => ids[0],
      update: async ({ where, data }: { where: { id: string }; data: Partial<typeof ids[number]> }) => {
        ids = ids.map(id => id.id === where.id ? { ...id, ...data } : id)
      },
    },
  }
  return {
    tx,
    reset: () => { selectedReads = 0; settings = { ...initialSettings }; ids = structuredClone(initialIds) },
    settings: () => settings,
    ids: () => ids,
    addRetained: () => { ids.push({ id: "second", scheme: "cvr", value: "RETAINED-CVR", countryCode: "US", isPrimary: false }) },
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
  seller.taxIds?.map(id => [id.scheme, id.value, id.countryCode ?? null])])
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
  it.each([true, false])("binds ordered retained IDs while editing the original primary for registration %s", async registered => {
    db.addRetained()
    hosted(true)
    const prepared = await runtime.prepareSellerVatConfirmation({ ...input, primaryTaxIdScheme: "vat" })
    await settings.update({ companyName: input.companyName, companyAddress: input.companyAddress,
      primaryTaxId: input.cvr, primaryTaxIdScheme: "vat", momsRegistered: registered, sellerVatConfirmationToken: prepared.token })
    expect(db.ids()[0]).toMatchObject({ id: "primary", scheme: "vat", value: input.cvr, countryCode: null })
    expect(db.ids()[2]).toMatchObject({ id: "second", scheme: "cvr", value: "RETAINED-CVR", countryCode: "US", isPrimary: false })
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ registered, seller: expect.objectContaining({ taxIds: [
      { scheme: "cvr", value: "RETAINED-CVR", countryCode: "US" },
      { scheme: "lei", value: "OTHER-ID", countryCode: "DK" },
      { scheme: "vat", value: input.cvr, countryCode: null },
    ] }) }))
  })

  it.each([true, false])("clears registration %s when the identity changes and accepts an explicit reconfirmation", async registered => {
    hosted(true)
    const prepareCurrent = () => runtime.prepareSellerVatConfirmation({ companyName: db.settings().companyName,
      companyAddress: db.settings().companyAddress, countryCode: "DK", cvr: db.ids()[0]!.value, primaryTaxIdScheme: db.ids()[0]!.scheme })
    await settings.update({ momsRegistered: registered, sellerVatConfirmationToken: (await prepareCurrent()).token })
    const edits = [{ companyName: "Changed seller" }, { companyAddress: "Changed address" },
      { primaryTaxId: "24256790" }, { primaryTaxId: "12345678", primaryTaxIdScheme: "cvr" }]
    for (const edit of edits) {
      confirm.mockClear()
      const prepared = await prepareCurrent()
      await settings.update(edit)
      expect(db.settings().momsRegistered).toBeNull()
      expect(confirm).not.toHaveBeenCalled()
      await expect(settings.update({ ...edit, momsRegistered: registered, sellerVatConfirmationToken: prepared.token })).rejects.toMatchObject({ code: "CONFLICT" })
      expect(db.settings().momsRegistered).toBeNull()
      db.reset()
      await settings.update({ momsRegistered: registered, sellerVatConfirmationToken: (await prepareCurrent()).token })
    }
    confirm.mockClear()
    await settings.update({ companyName: "Original seller", companyAddress: "Testvej 1", primaryTaxId: " 12345678 ", primaryTaxIdScheme: "vat" })
    expect(confirm).not.toHaveBeenCalled()
    expect(db.settings()).toMatchObject({ momsRegistered: registered })
    const prepared = await runtime.prepareSellerVatConfirmation({ companyName: "Changed seller", companyAddress: "Testvej 1", countryCode: "DK", cvr: "12345678", primaryTaxIdScheme: "vat" })
    await settings.update({ companyName: "Changed seller", momsRegistered: registered, sellerVatConfirmationToken: prepared.token })
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ registered, seller: expect.objectContaining({ companyName: "Changed seller" }) }))
    expect(db.settings()).toMatchObject({ companyName: "Changed seller", momsRegistered: registered })
  })

  it("allows unknown-status identity edits and self-hosted edits without a confirmation gate", async () => {
    hosted(true)
    const prepared = await runtime.prepareSellerVatConfirmation({ companyName: db.settings().companyName,
      companyAddress: db.settings().companyAddress, countryCode: "DK", cvr: db.ids()[0]!.value, primaryTaxIdScheme: "vat" })
    await settings.update({ momsRegistered: null, sellerVatConfirmationToken: prepared.token })
    confirm.mockClear()
    await settings.update({ companyName: "Unknown seller" })
    expect(db.settings()).toMatchObject({ companyName: "Unknown seller", momsRegistered: null })
    vi.stubEnv("QUITS_DISTRIBUTION", "selfhost")
    await settings.update({ companyAddress: "Self-host address", momsRegistered: false })
    await settings.update({ companyName: "Self-host seller" })
    expect(db.settings()).toMatchObject({ companyName: "Self-host seller", momsRegistered: false })
    expect(confirm).not.toHaveBeenCalled()
  })
  it.each([{ taxRegime: "custom" as const }, { countryCode: "US" }])("clears an unconfirmed choice when re-entering Danish VAT from %j", async outside => {
    hosted(true)
    await settings.update({ ...outside, momsRegistered: false })
    await settings.update({ countryCode: "DK", taxRegime: "eu_vat" })
    expect(db.settings()).toMatchObject({ countryCode: "DK", taxRegime: "eu_vat", momsRegistered: null })
    expect(confirm).not.toHaveBeenCalled()
  })
  it.each([true, false])("clears retained %s on Danish VAT entry unless the choice is sent again", async registered => {
    hosted(true)
    const prepareCurrent = () => runtime.prepareSellerVatConfirmation({ companyName: db.settings().companyName,
      companyAddress: db.settings().companyAddress, countryCode: "DK", cvr: db.ids()[0]!.value, primaryTaxIdScheme: db.ids()[0]!.scheme })
    await settings.update({ momsRegistered: registered, sellerVatConfirmationToken: (await prepareCurrent()).token })
    await settings.update({ taxRegime: "custom" })
    confirm.mockClear()
    await settings.update({ taxRegime: "eu_vat" })
    expect(db.settings()).toMatchObject({ taxRegime: "eu_vat", momsRegistered: null })
    expect(confirm).not.toHaveBeenCalled()
    const stale = await prepareCurrent()
    await expect(settings.update({ companyName: "Unreviewed identity", momsRegistered: registered, sellerVatConfirmationToken: stale.token })).rejects.toMatchObject({ code: "CONFLICT" })
    expect(db.settings()).toMatchObject({ taxRegime: "eu_vat", companyName: "Original seller", momsRegistered: null })
    await settings.update({ momsRegistered: registered, sellerVatConfirmationToken: (await prepareCurrent()).token })
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
