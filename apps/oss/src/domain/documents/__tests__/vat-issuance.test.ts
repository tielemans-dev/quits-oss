import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { requireSellerVatRegistration, requireVatIssuance } from "../vat-issuance"

const taxed = {
  currency: "DKK", pricesIncludeTax: false,
  subtotalNet: "100", totalTax: "25", totalGross: "125", vatEvidence: {},
  sellerSnapshot: { momsRegistered: false, taxIds: [{ scheme: "cvr", value: "24256790" }, { scheme: "vat", value: "DK24256790" }] },
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
  it.each([true, null, undefined])("preserves charged VAT when registration is %s", async momsRegistered => {
    expect(await Effect.runPromise(Effect.either(requireVatIssuance({ ...taxed, sellerSnapshot: { ...taxed.sellerSnapshot, momsRegistered } })))).toMatchObject({ _tag: "Right" })
  })
  it("accepts zero-tax out-of-scope lines without changing their category", async () => {
    const document = { ...taxed, totalTax: "0", totalGross: "100", items: [{ ...taxed.items[0]!, vatTreatment: "out_of_scope", vatRateInput: "0", taxRate: "0", lineTax: "0", lineGross: "100" }] }
    expect(await Effect.runPromise(Effect.either(requireVatIssuance(document)))).toMatchObject({ _tag: "Right" })
    expect(document.items[0]!.vatTreatment).toBe("out_of_scope")
  })
})

describe("nonregistered zero treatment semantics", () => {
  it.each(["exempt", "intra_community", "export", "zero_rated", "reverse_charge_domestic"])("rejects %s before invoice/quote or agreement issuance", async vatTreatment => {
    const document = { ...taxed, vatEvidence: { statementText: "Health exemption" }, totalTax: "0", totalGross: "100", items: [{ ...taxed.items[0]!, vatTreatment, vatReasonCode: "health", vatRateInput: "0", taxRate: "0", lineTax: "0", lineGross: "100" }] }
    for (const check of [requireSellerVatRegistration, requireVatIssuance]) {
      expect(await Effect.runPromise(Effect.either(check(document)))).toMatchObject({ _tag: "Left", left: { code: "seller_not_vat_registered" } })
    }
  })
  it("preserves ordinary domestic zero agreement lines", async () => {
    const document = { ...taxed, totalTax: "0", items: [{ ...taxed.items[0]!, vatTreatment: "standard", vatRateInput: "0", taxRate: "0", lineTax: "0" }] }
    expect(await Effect.runPromise(Effect.either(requireSellerVatRegistration(document)))).toMatchObject({ _tag: "Right" })
  })
})
