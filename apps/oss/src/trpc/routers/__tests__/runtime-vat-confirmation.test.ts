import { afterEach, describe, expect, it, vi } from "vitest"
import type { SellerSnapshot } from "@quits/contracts/documents"
import { setRuntimeExtensions } from "../../../lib/runtime/extensions"
import { confirmSellerVatStatus, type SellerVatConfirmationTransaction } from "../../../lib/runtime/seller-vat-confirmation"

const { findMany, prepare } = vi.hoisted(() => ({ findMany: vi.fn(), prepare: vi.fn() }))
vi.mock("../../../lib/db", () => ({ prisma: { organizationTaxId: { findMany } } }))
vi.mock("../../../lib/runtime/company-lookup", () => ({ lookupOnboardingCompany: vi.fn() }))
// MOCK: authentication is tested separately; retain tRPC input parsing and the real route handler.
vi.mock("../../init", async () => {
  const { initTRPC } = await import("@trpc/server")
  const t = initTRPC.create()
  return { router: t.router, publicProcedure: t.procedure, authorizedProcedure: () => t.procedure }
})
import { runtimeRouter } from "../runtime"

afterEach(() => { setRuntimeExtensions([]); vi.unstubAllEnvs(); vi.resetAllMocks() })

describe("hosted confirmation preparation", () => {
  it.each(["vat", "cvr", "DK_CVR"])("prepares the final Settings %s representation, including retained IDs", async scheme => {
    vi.stubEnv("QUITS_DISTRIBUTION", "cloud")
    const stored = [{ scheme: "vat", value: "12345678", countryCode: null }, { scheme: "lei", value: "OTHER-ID", countryCode: "DK" }]
    findMany.mockResolvedValue(stored)
    const finalSeller = { companyName: "Synthetic seller", companyAddress: "Testvej 1", countryCode: "DK",
      taxIds: [{ ...stored[0]!, scheme, value: "24256790" }, stored[1]!] }
    const identity = (seller: SellerSnapshot) => JSON.stringify([seller.companyName, seller.companyAddress, seller.countryCode,
      seller.taxIds?.map(id => [id.scheme, id.value, id.countryCode ?? null]).sort()])
    prepare.mockImplementation(async ({ seller }) => ({ token: identity(seller) }))
    setRuntimeExtensions([{ id: "synthetic-binding", resolveCapabilities: () => ({ sellerVatConfirmation: { enabled: true } }),
      sellerVatConfirmation: { prepare, confirm: async ({ seller, token }) => { if (identity(seller) !== token) throw new Error("Identity changed") } },
    }])
    const caller = runtimeRouter.createCaller({ organizationId: "org", user: { id: "user" }, session: { session: { id: "session" } } } as never)
    const { token } = await caller.prepareSellerVatConfirmation({ companyName: finalSeller.companyName,
      companyAddress: finalSeller.companyAddress, countryCode: "DK", cvr: "24256790", primaryTaxIdScheme: scheme })
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ seller: finalSeller }))
    const tx = { orgSettings: { findUniqueOrThrow: async () => ({ ...finalSeller, taxRegime: "eu_vat" }) },
      organizationTaxId: { findMany: async () => finalSeller.taxIds } } as unknown as SellerVatConfirmationTransaction
    await expect(confirmSellerVatStatus({ organizationId: "org", userId: "user", sessionId: "session", tx, registered: false, token })).resolves.toBeUndefined()
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] }))
  })
})
