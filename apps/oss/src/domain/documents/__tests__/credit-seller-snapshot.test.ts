import { describe, expect, it } from "vitest"
import { creditSellerSnapshot } from "../snapshots"
import { creditNotePdfParties } from "../../../lib/credit-notes/pdf-parties"

// MOCK: synthetic seller settings and tax identifiers only.
const settings = { companyName: "Synthetic Seller", companyEmail: "seller@example.test", companyAddress: "Testvej 1", countryCode: "DK" }
const taxIds = [{ scheme: "cvr", value: "12345678", countryCode: "DK" }]
describe("historical credit seller fallback", () => {
  it.each([true, false, null])("retains PDF identity without current VAT registration %s", momsRegistered => {
    const sellerSnapshot = creditSellerSnapshot(null, { ...settings, momsRegistered }, taxIds)
    expect(sellerSnapshot).toEqual({ ...settings, taxIds })
    expect(sellerSnapshot).not.toHaveProperty("momsRegistered")
    const { seller } = creditNotePdfParties({ sellerSnapshot, contact: { name: "Synthetic buyer" }, locale: "en-US" }, {})
    expect(seller).toMatchObject({ name: settings.companyName, email: settings.companyEmail, address: settings.companyAddress })
    expect(seller.taxIds.join(" ")).toContain("12345678")
  })
  it("inherits the source identity and VAT status while removing payment instructions", () => {
    const source = { companyName: "Frozen seller", momsRegistered: false, bankAccount: { iban: "synthetic" }, paymentNote: "Synthetic instruction" }
    expect(creditSellerSnapshot(source, { ...settings, momsRegistered: true }, taxIds)).toEqual({ companyName: "Frozen seller", momsRegistered: false })
    expect(source).toHaveProperty("bankAccount")
  })
})
