// MOCK: synthetic seller identities and registration choices only.
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import type { SellerSnapshot } from "@quits/contracts/documents"
import { withSellerVatStatus } from "../snapshots"

const seller = {
  countryCode: "DK", companyName: "Synthetic seller A", companyAddress: "Testvej 1",
  taxIds: [{ scheme: "cvr", value: "12345678", countryCode: "DK" }],
}
const refresh = (retained: SellerSnapshot, current: SellerSnapshot, taxRegime = "eu_vat") => {
  return Effect.runPromise(withSellerVatStatus(retained, current, taxRegime))
}
describe("VAT registration belongs to the effective seller", () => {
  it.each(["us_sales_tax", "custom"])("keeps the frozen %s identity despite missing or changed address", async regime => {
    const retained = { ...seller, countryCode: regime === "custom" ? "DK" : "US", companyAddress: null, momsRegistered: false }
    const current = { ...retained, companyName: "Current seller", companyAddress: "New address", momsRegistered: true }
    expect(await refresh(retained, current, regime)).toBe(retained)
    expect(await refresh({ ...retained, companyAddress: "Old address" }, current, regime)).toEqual({ ...retained, companyAddress: "Old address" })
  })
  it("keeps non-Danish EU-VAT linked identity without a Danish confirmation gate", async () => {
    const retained = { countryCode: "DE", companyName: "Agreed seller", companyAddress: null, momsRegistered: true }
    expect(await refresh(retained, { ...retained, companyAddress: "New address", momsRegistered: false })).toBe(retained)
  })
  it.each([true, false])("refuses changed CVR when retained registration is %s", async registered => {
    const retained = { ...seller, momsRegistered: registered }
    const current = { ...seller, momsRegistered: !registered, taxIds: [{ scheme: "cvr", value: "87654321", countryCode: "DK" }] }
    await expect(refresh(retained, current)).rejects.toThrow("seller")
    expect(retained.momsRegistered).toBe(registered)
    expect(retained.taxIds[0]!.value).toBe("12345678")
  })
  it.each([true, false])("refreshes matching CVR from registration %s without changing agreed identity", async registered => {
    const retained = { ...seller, momsRegistered: registered }
    const current = { ...seller, companyName: "Current trading name", momsRegistered: !registered }
    expect(await refresh(retained, current)).toEqual({ ...retained, momsRegistered: !registered })
  })
  it.each([
    { countryCode: "DE" }, { countryCode: null }, { taxIds: [] },
    { taxIds: [{ scheme: "cvr", value: "12345678", countryCode: "DE" }] },
    { taxIds: [{ scheme: "cvr", value: "12345678", countryCode: "DK" }, { scheme: "cvr", value: "87654321", countryCode: "DK" }] },
  ])("refuses incomplete or conflicting retained identity %j", async identity => {
    await expect(refresh({ ...seller, ...identity }, { ...seller, momsRegistered: true })).rejects.toThrow("agreed seller")
  })
  it("requires full known identity without a CVR", async () => {
    const retained = { ...seller, taxIds: [], momsRegistered: false }
    expect(await refresh(retained, { ...retained, momsRegistered: true })).toEqual({ ...retained, momsRegistered: true })
    await expect(refresh(retained, { ...retained, companyName: "Seller B", momsRegistered: true })).rejects.toThrow("agreed seller")
    await expect(refresh({ ...retained, companyAddress: null }, { ...retained, companyAddress: null })).rejects.toThrow("agreed seller")
  })
  it("keeps unknown current registration unknown for the same seller", async () => {
    expect(await refresh({ ...seller, momsRegistered: true }, { ...seller, momsRegistered: null })).toEqual({ ...seller, momsRegistered: null })
  })

})
