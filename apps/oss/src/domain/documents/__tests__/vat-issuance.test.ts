import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { requireVatIssuance } from "../vat-issuance"

const taxed = {
  taxRegime: "eu_vat", currency: "DKK", pricesIncludeTax: false,
  subtotalNet: "100", totalTax: "25", totalGross: "125", vatEvidence: {},
  sellerSnapshot: { countryCode: "DK", momsRegistered: false, taxIds: [{ scheme: "cvr", value: "24256790" }, { scheme: "vat", value: "DK24256790" }] },
  buyerSnapshot: { country: "DK" },
  items: [{ vatRateInput: "0.25", vatTreatment: "standard", vatReasonCode: null, vatCountry: "DK", taxRate: "25", lineNet: "100", lineTax: "25", lineGross: "125" }],
}

describe("seller registration at financial issuance", () => {
  it("rejects VAT even when the seller has retained VAT and CVR identifiers", async () => {
    expect(await Effect.runPromise(Effect.either(requireVatIssuance(taxed)))).toMatchObject({ _tag: "Left", left: { code: "seller_not_vat_registered" } })
  })
  it("rejects a positive rate even when a tiny line rounds its tax to zero", async () => {
    const document = { ...taxed, subtotalNet: "0.01", totalTax: "0", totalGross: "0.01", items: [{ ...taxed.items[0]!, lineNet: "0.01", lineTax: "0", lineGross: "0.01" }] }
    expect(await Effect.runPromise(Effect.either(requireVatIssuance(document)))).toMatchObject({ _tag: "Left", left: { code: "seller_not_vat_registered" } })
  })
  it.each([true])("preserves charged VAT when registration is %s", async momsRegistered => {
    expect(await Effect.runPromise(Effect.either(requireVatIssuance({ ...taxed, sellerSnapshot: { ...taxed.sellerSnapshot, momsRegistered } })))).toMatchObject({ _tag: "Right" })
  })
  it.each([null, undefined])("refuses unset Danish registration %s", async momsRegistered => {
    expect(await Effect.runPromise(Effect.either(requireVatIssuance({ ...taxed, sellerSnapshot: { ...taxed.sellerSnapshot, momsRegistered } })))).toMatchObject({ _tag: "Left", left: { code: "seller_vat_status_unset" } })
  })
  it("preserves custom-tax issuance despite remembered non-registration", async () => {
    expect(await Effect.runPromise(Effect.either(requireVatIssuance({ ...taxed, taxRegime: "custom" })))).toMatchObject({ _tag: "Right" })
  })
  it("rejects positive document tax even when stored line rates and tax are zero", async () => {
    const document = { ...taxed, items: [{ ...taxed.items[0]!, vatTreatment: "unclassified_zero", vatRateInput: "0", taxRate: "0", lineTax: "0", lineGross: "100" }] }
    expect(await Effect.runPromise(Effect.either(requireVatIssuance(document)))).toMatchObject({ _tag: "Left", left: { code: "seller_not_vat_registered" } })
  })
  it.each([false, true, null, undefined])("permits ordinary unclassified zero only for explicitly false registration, got %s", async momsRegistered => {
    const document = { ...taxed, totalTax: "0", totalGross: "100", sellerSnapshot: { ...taxed.sellerSnapshot, momsRegistered }, items: [{ ...taxed.items[0]!, vatTreatment: "unclassified_zero", vatRateInput: "0", taxRate: "0", lineTax: "0", lineGross: "100" }] }
    expect(await Effect.runPromise(Effect.either(requireVatIssuance(document)))).toMatchObject(momsRegistered === false
      ? { _tag: "Right" }
      : { _tag: "Left", left: { code: momsRegistered === true ? "evidence_incomplete" : "seller_vat_status_unset" } })
    expect(document.items[0]!.vatTreatment).toBe("unclassified_zero")
  })
  it("accepts zero-tax out-of-scope lines without changing their category", async () => {
    const document = { ...taxed, totalTax: "0", totalGross: "100", items: [{ ...taxed.items[0]!, vatTreatment: "out_of_scope", vatRateInput: "0", taxRate: "0", lineTax: "0", lineGross: "100" }] }
    expect(await Effect.runPromise(Effect.either(requireVatIssuance(document)))).toMatchObject({ _tag: "Right" })
    expect(document.items[0]!.vatTreatment).toBe("out_of_scope")
  })
})
