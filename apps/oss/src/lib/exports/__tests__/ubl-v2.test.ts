import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { FrozenVatGroup } from "@quits/contracts/pricing"
import { buildUblDocument, computeEinvoiceTotals, validateEinvoice, EinvoiceVatError, type EinvoiceDocument } from "../ubl"

const legacy = JSON.parse(readFileSync(new URL("./fixtures/legacy-ubl-input.json", import.meta.url), "utf8")) as EinvoiceDocument
function group(treatment: FrozenVatGroup["treatment"], reasonCode: FrozenVatGroup["reasonCode"] = null): FrozenVatGroup {
  return { key: `${treatment}:${reasonCode}`, treatment, reasonCode, country: null, rate: treatment === "standard" ? "0.25" : "0",
    exponent: 2, baseExponent: 2, net: "100", tax: treatment === "standard" ? "25" : "0", gross: treatment === "standard" ? "125" : "100", payableRounding: "0",
    netBase: null, taxBase: null, grossBase: null, payableRoundingBase: null, evidence: { statementText: "Frozen statement" } }
}
function document(groups: FrozenVatGroup[]): EinvoiceDocument {
  return { ...legacy, calculationVersion: "v2", frozenGroups: groups, amountPaid: 0,
    lines: groups.map((g) => ({ description: "Frozen sale", quantity: "1", unitPriceNet: g.net, lineNet: g.net,
      taxRate: "99", taxCategory: g.treatment, vatTreatment: g.treatment, groupKey: g.key })),
  }
}
const categories = [
  ["standard", null, "S"], ["intra_community", "goods", "K"], ["intra_community", "services_b2b", "AE"],
  ["export", "goods_outside_eu", "G"], ["exempt", "health", "E"], ["reverse_charge_domestic", "construction", "AE"],
  ["out_of_scope", null, "O"], ["zero_rated", null, "Z"],
] as const

describe("versioned UBL", () => {
  it.each(["zero_rated", "exempt", "out_of_scope"] as const)("requires a seller VAT identifier except for exempt sales (BT-32) or frozen category O: %s", treatment => {
    const doc = document([group(treatment, treatment === "exempt" ? "health" : null)])
    doc.seller = { ...doc.seller, momsRegistered: false, vatId: null }
    doc.lines = doc.lines.map(line => ({ ...line, taxRate: 0 }))
    expect(validateEinvoice(doc).includes("seller.taxId")).toBe(treatment === "zero_rated")
    expect(validateEinvoice({ ...doc, seller: { ...doc.seller, legalId: null } }).includes("seller.taxId")).toBe(treatment !== "out_of_scope")
    if (treatment === "out_of_scope") expect(buildUblDocument(doc).split("</cac:AccountingSupplierParty>")[0]).not.toContain("cac:PartyTaxScheme")
  })
  it("uses frozen treatments rather than misleading nominal line rates or categories", () => {
    const doc = document([group("zero_rated")])
    doc.seller = { ...doc.seller, momsRegistered: false, vatId: null }
    doc.lines = doc.lines.map(line => ({ ...line, taxRate: 0, vatTreatment: "out_of_scope" }))
    expect(validateEinvoice(doc)).toContain("seller.taxId")
    const legacyZero = { ...legacy, seller: doc.seller, lines: [{ ...legacy.lines[0]!, taxRate: 0 }] }
    expect(validateEinvoice(legacyZero)).toContain("seller.taxId")
  })
  it("keeps the captured pre-A2b legacy bytes unchanged", () => {
    expect(buildUblDocument(legacy)).toBe(readFileSync(new URL("./fixtures/legacy-ubl.xml", import.meta.url), "utf8"))
  })
  it.each(categories)("exports frozen %s / %s as %s", (treatment, reasonCode, category) => {
    const xml = buildUblDocument(document([group(treatment, reasonCode)]))
    expect(xml).toMatchSnapshot()
    expect(xml).toContain(`<cbc:ID>${category}</cbc:ID>`)
    if (category === "AE") expect(xml).toContain("Reverse charge")
    if (!["S", "Z"].includes(category)) expect(xml).toContain("Frozen statement")
  })
  it("reads tax and negative rounding from frozen components, never nominal line rates", () => {
    const g = { ...group("standard"), net: "0.02", tax: "0.01", gross: "0.02", payableRounding: "-0.01" }
    const totals = computeEinvoiceTotals(document([g]))
    expect([totals.tax, totals.rounding, totals.payable]).toEqual(["0.01", "-0.01", "0.02"])
    expect(buildUblDocument(document([g]))).toContain('<cbc:PayableRoundingAmount currencyID="DKK">-0.01</cbc:PayableRoundingAmount>')
  })
  it("omits Percent on every O category (BR-O-05)", () => {
    const xml = buildUblDocument(document([group("out_of_scope")]))
    expect(xml).not.toContain("cbc:Percent")
  })
  it("refuses mixed O and other categories (BR-O-11)", () => {
    expect(() => buildUblDocument(document([group("out_of_scope"), group("standard")]))).toThrow(EinvoiceVatError)
    expect(() => buildUblDocument(document([group("out_of_scope"), group("standard")]))).toThrow(/BR-O-11/)
  })
  it("TaxTotal equals the sum of frozen TaxSubtotals (BR-CO-14)", () => {
    const xml = buildUblDocument(document([group("standard"), group("exempt", "health")]))
    const taxes = [...xml.matchAll(/<cbc:TaxAmount[^>]*>([^<]+)<\/cbc:TaxAmount>/g)].map((m) => Number(m[1]))
    expect(taxes[0]).toBe(taxes.slice(1).reduce((sum, tax) => sum + tax, 0))
  })
  it("standard invoice group tax agrees with rounded taxable times rate (BR-CO-17)", () => {
    const totals = computeEinvoiceTotals(document([group("standard")]))
    for (const subtotal of totals.groups) expect(Number(subtotal.tax)).toBe(Math.round(Number(subtotal.taxable) * Number(subtotal.rate)) / 100)
  })
  it("refuses unclassified zero with a typed error for both versions", () => {
    for (const doc of [document([group("unclassified_zero")]), { ...legacy, lines: [{ ...legacy.lines[0]!, vatTreatment: "unclassified_zero" }] }]) {
      try { buildUblDocument(doc); throw new Error("Expected refusal") }
      catch (error) { expect(error).toBeInstanceOf(EinvoiceVatError); expect(error).toMatchObject({ code: "unclassified_zero" }) }
    }
  })
})
