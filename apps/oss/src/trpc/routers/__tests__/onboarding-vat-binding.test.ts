import { afterEach, describe, expect, it, vi } from "vitest"
import { confirmOnboardingV2Schema } from "@quits/contracts/onboarding"
import type { SellerSnapshot } from "@quits/contracts/documents"
import { setRuntimeExtensions } from "../../../lib/runtime/extensions"

// MOCK: only persistence/authentication/billing. The real prepare handler and complete
// onboarding transaction must agree for a provider binding every seller field and ID order.
const db = vi.hoisted(() => {
  let settings: Record<string, unknown> = {}
  let selectedReads = 0
  let ids: Array<{ scheme: string; value: string; countryCode: string | null; isPrimary: boolean; createdAt: Date }> = []
  const tx = {
    $queryRaw: vi.fn(async () => []),
    orgSettings: {
      findUnique: async () => settings,
      findUniqueOrThrow: async () => settings,
      upsert: async ({ update }: { update: Record<string, unknown> }) => (settings = { ...settings, ...update }),
    },
    organization: { update: vi.fn() },
    organizationTaxId: {
      findMany: async ({ select, orderBy }: { select?: object; orderBy?: Array<{ isPrimary?: string }> }) => {
        // Equal timestamps permit different database tie order on each read.
        const rows = select && selectedReads++ > 0 ? [...ids].reverse() : [...ids]
        const ordered = rows.sort((a, b) =>
          (orderBy?.some(order => order.isPrimary) ? Number(b.isPrimary) - Number(a.isPrimary) : 0) ||
          a.createdAt.getTime() - b.createdAt.getTime())
        return select ? ordered.map(({ scheme, value, countryCode }) => ({ scheme, value, countryCode })) : ordered
      },
      updateMany: async () => { ids = ids.map(id => ({ ...id, isPrimary: false })) },
      deleteMany: async () => { ids = ids.filter(id => !["cvr", "vat", "dk_cvr", "dk_vat"].includes(id.scheme.toLowerCase())) },
      createMany: async ({ data }: { data: typeof ids }) => { ids.push(...data.map(id => ({ ...id, createdAt: new Date("2026-02-02") }))) },
    },
    invoice: { count: async () => 0 }, quote: { count: async () => 0 },
  }
  return { tx, reset: () => {
    selectedReads = 0
    settings = { invoicePrefix: "2026", quotePrefix: "Q", invoiceNextNum: 1, quoteNextNum: 1 }
    ids = [{ scheme: "lei", value: "RETAINED", countryCode: null, isPrimary: true, createdAt: new Date("2026-01-01") },
      { scheme: "DK_VAT", value: "DK12345678", countryCode: "DK", isPrimary: false, createdAt: new Date("2026-01-01") },
      { scheme: "local", value: "SECOND-RETAINED", countryCode: "US", isPrimary: false, createdAt: new Date("2026-01-01") }]
  } }
})
vi.mock("../../../lib/db", () => ({ prisma: { ...db.tx, $transaction: async (run: (tx: typeof db.tx) => Promise<unknown>) => run(db.tx) } }))
vi.mock("../../../lib/billing", () => ({ billingProvider: {} }))
vi.mock("../../../domain/documents/base-currency", () => ({ hasIssuedDocuments: async () => false }))
vi.mock("../../../lib/runtime/company-lookup", () => ({ lookupOnboardingCompany: vi.fn() }))
vi.mock("../../init", async () => {
  const { initTRPC } = await import("@trpc/server")
  const t = initTRPC.create()
  return { router: t.router, publicProcedure: t.procedure, authorizedProcedure: () => t.procedure }
})
import { runtimeRouter } from "../runtime"
import { confirmOnboardingV2 } from "../../../lib/onboarding/confirm-v2"
const identity = (seller: SellerSnapshot) => JSON.stringify(seller)
afterEach(() => { setRuntimeExtensions([]); vi.unstubAllEnvs(); vi.clearAllMocks() })
describe("onboarding full seller token binding", () => {
  it.each([true, false])("prepares the exact final seller for registration %s", async momsRegistered => {
    db.reset()
    vi.stubEnv("QUITS_DISTRIBUTION", "cloud")
    const prepare = vi.fn(async ({ seller }: { seller: SellerSnapshot }) => ({ token: identity(seller) }))
    const confirm = vi.fn(async ({ seller, token }: { seller: SellerSnapshot; token: string }) => {
      if (identity(seller) !== token) throw new Error("Identity changed")
    })
    setRuntimeExtensions([{ id: "full-seller-binding", resolveCapabilities: () => ({ sellerVatConfirmation: { enabled: true }, onboardingV2: { nonVatEnabled: true } }), sellerVatConfirmation: { prepare, confirm } }])
    const actor = { organizationId: "org", userId: "user", sessionId: "session" }
    const caller = runtimeRouter.createCaller({ organizationId: "org", user: { id: "user" }, session: { session: { id: "session" } } } as never)
    const input = confirmOnboardingV2Schema.parse({ companyName: "Reviewed seller", companyForm: "ApS", companyAddress: "Testvej 1", cvr: "24256790", momsRegistered,
      ...(momsRegistered ? { vatId: "DK24256790" } : {}), idempotencyKey: "4a8d7e5c-b2f1-4f72-8ba3-b58e21b55d45", source: "manual" })
    const { token } = await caller.prepareSellerVatConfirmation({ companyName: input.companyName, companyAddress: input.companyAddress,
      countryCode: "DK", cvr: input.cvr, ...(input.vatId ? { vatId: input.vatId } : {}) })
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ seller: { companyName: input.companyName, companyAddress: input.companyAddress, countryCode: "DK",
      taxIds: [{ scheme: "cvr", value: input.cvr, countryCode: "DK" }, { scheme: "lei", value: "RETAINED", countryCode: null },
        { scheme: "local", value: "SECOND-RETAINED", countryCode: "US" },
        ...(momsRegistered ? [{ scheme: "vat", value: "DK24256790", countryCode: "DK" }] : [])] } }))
    await expect(confirmOnboardingV2("org", { ...input, sellerVatConfirmationToken: token }, "signup@example.test", actor)).resolves.toMatchObject({ status: "complete" })
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ registered: momsRegistered, token }))
    const seller = confirm.mock.calls[0]![0].seller
    await expect(confirm({ seller: { ...seller, companyName: "Unreviewed seller" }, token })).rejects.toThrow("Identity changed")
  })
})
