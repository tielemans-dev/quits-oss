import { afterEach, describe, expect, it, vi } from "vitest"
import { confirmSellerVatStatus, type SellerVatConfirmationTransaction } from "../runtime/seller-vat-confirmation"
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
  it("fails closed when the enabled provider is missing", async () => {
    enabled(); setRuntimeExtensions([{ id: "missing", resolveCapabilities: () => ({ sellerVatConfirmation: { enabled: true } }) }])
    await expect(confirmSellerVatStatus({ ...actor, tx, registered: true, token: "signed" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
  })
})
