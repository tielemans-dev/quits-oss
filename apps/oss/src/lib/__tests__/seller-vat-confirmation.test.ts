import { afterEach, describe, expect, it, vi } from "vitest"
import { settingsConfirmationTaxIds, confirmSellerVatStatus, type SellerVatConfirmationTransaction } from "../runtime/seller-vat-confirmation"
import { setRuntimeExtensions } from "../runtime/extensions"
const confirm = vi.fn(async () => {})
const actor = { organizationId: "org", userId: "user", sessionId: "session" }
const seller = { taxRegime: "eu_vat", companyName: "Synthetic Seller", companyAddress: "Testvej 1", countryCode: "DK" }
const taxIds = [{ scheme: "cvr", value: "24256790", countryCode: "DK" }]
const reads = { orgSettings: { findUniqueOrThrow: vi.fn(async () => seller) }, organizationTaxId: { findMany: vi.fn(async () => taxIds) } }
const tx = reads as unknown as SellerVatConfirmationTransaction
function enabled() {
  vi.stubEnv("QUITS_DISTRIBUTION", "cloud")
  setRuntimeExtensions([{ id: "operator", resolveCapabilities: () => ({ sellerVatConfirmation: { enabled: true } }), sellerVatConfirmation: { prepare: async () => ({ token: "signed" }), confirm } }])
}
afterEach(() => { setRuntimeExtensions([]); vi.unstubAllEnvs(); vi.clearAllMocks() })
describe("transactional seller VAT confirmation", () => {
  it("does not call a distribution service or gate a self-hosted financial save", async () => {
    enabled(); vi.stubEnv("QUITS_DISTRIBUTION", "selfhost")
    await confirmSellerVatStatus({ ...actor, tx, registered: false })
    expect(confirm).not.toHaveBeenCalled(); expect(reads.orgSettings.findUniqueOrThrow).not.toHaveBeenCalled()
  })
  it.each([true, false, null])("passes explicit registration/withdrawal %s and the final transactional identity", async registered => {
    enabled()
    await confirmSellerVatStatus({ ...actor, tx, registered, token: "signed" })
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ ...actor, tx, registered, token: "signed", seller: { companyName: seller.companyName, companyAddress: seller.companyAddress, countryCode: seller.countryCode, taxIds } }))
  })
  it("refuses a supplied choice without evidence, allows unrelated saves, and propagates rollback failures", async () => {
    enabled()
    await expect(confirmSellerVatStatus({ ...actor, tx, registered: false })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await confirmSellerVatStatus({ ...actor, tx })
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockRejectedValueOnce(new Error("identity changed"))
    await expect(confirmSellerVatStatus({ ...actor, tx, registered: true, token: "signed" })).rejects.toThrow("identity changed")
  })
  it.each([true, false])("clears stored registration %s when the compared identity changes", async registered => {
    enabled()
    const storedIds = [{ scheme: "vat", value: "12345678", countryCode: null }, { scheme: "lei", value: "SECONDARY", countryCode: "DK" }]
    let current = { ...seller, momsRegistered: registered as boolean | null }
    const localTx = {
      orgSettings: {
        findUniqueOrThrow: async () => current,
        update: async ({ data }: { data: { momsRegistered: null } }) => { current = { ...current, ...data } },
      },
      organizationTaxId: { findMany: async () => storedIds },
    } as unknown as SellerVatConfirmationTransaction
    const previousSeller = { ...seller, taxIds: [...storedIds].reverse() }
    await confirmSellerVatStatus({ ...actor, tx: localTx, previousSeller })
    expect(confirm).not.toHaveBeenCalled()
    expect(current.momsRegistered).toBe(registered)
    for (const change of [
      { taxIds: [{ ...storedIds[0]!, countryCode: "DK" }, storedIds[1]!] },
      { taxIds: [storedIds[0]!, { ...storedIds[1]!, value: "OLD-SECONDARY" }] },
      { companyName: "Previous seller" }, { companyAddress: "Previous address" },
    ]) {
      current = { ...seller, momsRegistered: registered }
      await confirmSellerVatStatus({ ...actor, tx: localTx, previousSeller: { ...previousSeller, ...change } })
      expect(current.momsRegistered).toBeNull()
      expect(confirm).not.toHaveBeenCalled()
    }
    await confirmSellerVatStatus({ ...actor, tx: localTx, previousSeller: { ...previousSeller, companyName: "Previous seller" }, registered: null, token: "signed-withdrawal" })
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ registered: null, seller: expect.objectContaining({ companyName: seller.companyName, taxIds: [...storedIds].reverse() }) }))
  })
  it("fails closed when the enabled provider is missing", async () => {
    enabled(); setRuntimeExtensions([{ id: "missing", resolveCapabilities: () => ({ sellerVatConfirmation: { enabled: true } }) }])
    await expect(confirmSellerVatStatus({ ...actor, tx, registered: true, token: "signed" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
  })
})

describe("Settings confirmation tax-ID representation", () => {
  it.each(["vat", "cvr", "DK_CVR"])("preserves the selected %s scheme and other stored IDs", scheme => {
    const stored = [{ scheme: "vat", value: "12345678", countryCode: null }, { scheme: "lei", value: "OTHER", countryCode: "DK" }]
    expect(settingsConfirmationTaxIds(stored, " 24256790 ", scheme)).toEqual([
      { scheme, value: "24256790", countryCode: null }, stored[1],
    ])
    expect(stored[0]!.value).toBe("12345678")
  })
  it("matches a new primary ID's nullable country instead of inventing a Danish CVR", () => {
    expect(settingsConfirmationTaxIds([], "24256790", "vat")).toEqual([{ scheme: "vat", value: "24256790", countryCode: null }])
  })
})
