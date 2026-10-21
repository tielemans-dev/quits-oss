// @vitest-environment jsdom
// MOCK: synthetic test parties, CVRs and amounts only.
import { describe, expect, it } from "vitest"
import type { FrozenVatGroup } from "@quits/contracts/pricing"
import { vatGroupKey } from "@quits/shared/pricing"
import { buildUblDocument, isEinvoiceVatClassified, validateEinvoice } from "../../../lib/exports/ubl"
import { frozenEinvoiceInput } from "../einvoice-input"

const group = (treatment: FrozenVatGroup["treatment"], reasonCode: FrozenVatGroup["reasonCode"], net: string): FrozenVatGroup => ({
  key: vatGroupKey({ treatment, country: null, reasonCode, rate: "0" }), treatment, reasonCode, country: null, rate: "0",
  exponent: 2, baseExponent: 2, net, tax: "0.00", gross: net, payableRounding: "0.00",
  netBase: net, taxBase: "0.00", grossBase: net, payableRoundingBase: "0.00" })
const zero = group("unclassified_zero", null, "8500.00")
const line = (treatment: string, reasonCode: string | null, lineNet: string) => ({ description: "Design", quantity: "1", unitPriceNet: lineNet, lineNet, taxRate: "0", taxCategory: treatment, vatTreatment: treatment, vatCountry: null, vatReasonCode: reasonCode, vatRateInput: "0" })

/** What issuance freezes for a Danish sole trader who is not VAT-registered, billing a Danish company. */
function issued(momsRegistered: boolean | null, options: { locale?: string; groups?: FrozenVatGroup[]; lines?: ReturnType<typeof line>[] } = {}) {
  const groups = options.groups ?? [zero]
  const net = groups.reduce((sum, group) => sum + Number(group.net), 0).toFixed(2)
  const tax = groups.reduce((sum, group) => sum + Number(group.tax), 0).toFixed(2)
  const gross = (Number(net) + Number(tax)).toFixed(2)
  return frozenEinvoiceInput({
    kind: "invoice", taxRegime: "eu_vat", countryCode: "DK", locale: options.locale ?? "da-DK", dueDate: "2026-11-04", orderReference: null, billingReference: null, note: null,
    money: {
      number: "2026-0005", issueDate: "2026-10-21", supplyDate: "2026-10-21", currency: "DKK",
      seller: { companyName: "Synthetic Enkeltmand", companyAddress: "Testvej 1\n9000 Aalborg", countryCode: "DK", momsRegistered, taxIds: [{ scheme: "cvr", value: "12345674", countryCode: "DK" }] },
      buyer: { name: "Synthetic Buyer", company: "Synthetic Buyer ApS", address: "Testvej 2", city: "Aalborg", zip: "9000", country: "DK", taxIds: [{ scheme: "cvr", value: "87654328", countryCode: "DK" }] },
      calculation: { version: "v2", roundingMode: "half_up", pricesIncludeTax: false, exponent: 2, baseExponent: 2 },
      vatGroups: groups, totals: { net, tax, gross, payableRounding: "0.00", netBase: net, taxBase: tax, grossBase: gross, payableRoundingBase: "0.00" },
    } as never,
    contact: { name: "Synthetic Buyer", email: null, company: "Synthetic Buyer ApS", address: "Testvej 2", city: "Aalborg", state: null, zip: "9000", country: "DK", taxId: null, taxIds: [], peppolEndpointId: null, peppolEndpointScheme: null } as never,
    lines: options.lines ?? [line("unclassified_zero", null, "8500")],
  })
}

const kids = (parent: Element, name: string) => [...parent.children].filter(child => child.tagName === name)
const kid = (parent: Element, name: string) => kids(parent, name)[0]
const text = (parent: Element | undefined, ...path: string[]) => path.reduce<Element | undefined>((node, name) => node && kid(node, name), parent)?.textContent ?? undefined
const amount = (parent: Element, name: string) => Number(text(parent, name))

/** The EN 16931 "Exempt from VAT" rules BR-E-01 to BR-E-10, and DK-R-002/DK-R-014, over UBL without allowances or charges. */
function exemptRuleViolations(xml: string) {
  const root = new DOMParser().parseFromString(xml, "application/xml").documentElement
  const violations: string[] = []
  const seller = kid(kid(root, "cac:AccountingSupplierParty")!, "cac:Party")!
  const buyer = kid(kid(root, "cac:AccountingCustomerParty")!, "cac:Party")!
  const lines = kids(root, "cac:InvoiceLine").map(line => ({ net: amount(line, "cbc:LineExtensionAmount"), category: kid(kid(line, "cac:Item")!, "cac:ClassifiedTaxCategory")! }))
  const exemptLines = lines.filter(line => text(line.category, "cbc:ID") === "E")
  const breakdowns = kids(kid(root, "cac:TaxTotal")!, "cac:TaxSubtotal").filter(subtotal => text(subtotal, "cac:TaxCategory", "cbc:ID") === "E")
  const taxSchemes = (party: Element, vat: boolean) => kids(party, "cac:PartyTaxScheme").filter(scheme => (text(scheme, "cac:TaxScheme", "cbc:ID") === "VAT") === vat)
  if (exemptLines.length && breakdowns.length !== 1) violations.push("BR-E-01")
  // BT-31, BT-32 or BT-63 (no tax representative is ever sent).
  if (exemptLines.length && !kids(seller, "cac:PartyTaxScheme").some(scheme => text(scheme, "cbc:CompanyID")?.trim())) violations.push("BR-E-02")
  if (exemptLines.some(line => Number(text(line.category, "cbc:Percent")) !== 0 || text(line.category, "cbc:Percent") === undefined)) violations.push("BR-E-05")
  for (const breakdown of breakdowns) {
    const expected = exemptLines.reduce((sum, line) => sum + line.net, 0)
    if (Math.abs(amount(breakdown, "cbc:TaxableAmount") - expected) > 0.001) violations.push("BR-E-08")
    if (amount(breakdown, "cbc:TaxAmount") !== 0) violations.push("BR-E-09")
    if (!text(breakdown, "cac:TaxCategory", "cbc:TaxExemptionReason")?.trim() && !text(breakdown, "cac:TaxCategory", "cbc:TaxExemptionReasonCode")?.trim()) violations.push("BR-E-10")
  }
  // BR-CO-09: VAT identifiers carry a country prefix; the BT-32 registration number is not one.
  if ([...taxSchemes(seller, true), ...taxSchemes(buyer, true)].some(scheme => !/^[A-Z]{2}/.test(text(scheme, "cbc:CompanyID") ?? ""))) violations.push("BR-CO-09")
  const legal = kid(kid(seller, "cac:PartyLegalEntity")!, "cbc:CompanyID")
  if (text(seller, "cac:PostalAddress", "cac:Country", "cbc:IdentificationCode") === "DK") {
    if (!legal?.textContent?.trim()) violations.push("DK-R-002")
    else if (legal.getAttribute("schemeID") !== "0184") violations.push("DK-R-014")
  }
  return { violations, seller, buyer, breakdowns, taxSchemes }
}

describe("frozen e-invoice input", () => {
  it("exports a seller who is not VAT-registered as small-business exempt (category E), so issuance stores its UBL", () => {
    const document = issued(false)
    expect(isEinvoiceVatClassified(document)).toBe(true)
    expect(validateEinvoice(document)).toEqual([])
    const xml = buildUblDocument(document)
    const { violations, seller, buyer, breakdowns, taxSchemes } = exemptRuleViolations(xml)
    expect(violations).toEqual([])
    expect(breakdowns.map(breakdown => [text(breakdown, "cac:TaxCategory", "cbc:ID"), text(breakdown, "cac:TaxCategory", "cbc:Percent")])).toEqual([["E", "0"]])
    expect(xml).toMatch(/<cac:ClassifiedTaxCategory>\s*<cbc:ID>E<\/cbc:ID>\s*<cbc:Percent>0<\/cbc:Percent>/)
    expect(xml).not.toContain("<cbc:ID>O</cbc:ID>")
    expect(xml).not.toContain("TaxExemptionReasonCode")
    expect(text(breakdowns[0], "cac:TaxCategory", "cbc:TaxExemptionReason")).toBe("Momsfritaget – lille virksomhed, jf. momslovens § 71 e (ikke momsregistreret)")
    // No seller VAT identifier (BT-31); the CVR is the tax registration identifier (BT-32) and the legal ID (BT-30).
    expect(taxSchemes(seller, true)).toEqual([])
    expect(taxSchemes(seller, false).map(scheme => [text(scheme, "cbc:CompanyID"), text(scheme, "cac:TaxScheme", "cbc:ID")])).toEqual([["12345674", "TAX"]])
    expect(xml).toContain('<cbc:CompanyID schemeID="0184">12345674</cbc:CompanyID>')
    // Category E allows the buyer VAT identifier (BT-48).
    expect(taxSchemes(buyer, true).map(scheme => text(scheme, "cbc:CompanyID"))).toEqual(["DK87654328"])
    expect(xml).toContain('<cbc:EndpointID schemeID="0184">87654328</cbc:EndpointID>')
  })
  it("gives the exemption reason in English on an English document", () => {
    const { breakdowns } = exemptRuleViolations(buildUblDocument(issued(false, { locale: "en-US" })))
    expect(text(breakdowns[0], "cac:TaxCategory", "cbc:TaxExemptionReason")).toBe("Exempt from VAT – small business under section 71 e of the Danish VAT Act (momsloven) (not VAT-registered)")
  })
  it("sends one exempt VAT breakdown beside an exempt health line (BR-E-01)", () => {
    const document = issued(false, { groups: [group("unclassified_zero", null, "8500.00"), group("exempt", "health", "500.00")], lines: [line("unclassified_zero", null, "8500"), line("exempt", "health", "500")] })
    expect(validateEinvoice(document)).toEqual([])
    const { violations, breakdowns } = exemptRuleViolations(buildUblDocument(document))
    expect(violations).toEqual([])
    expect(amount(breakdowns[0]!, "cbc:TaxableAmount")).toBe(9000)
    expect(text(breakdowns[0], "cac:TaxCategory", "cbc:TaxExemptionReason")).toBe("Momsfritaget – lille virksomhed, jf. momslovens § 71 e (ikke momsregistreret); Exempt health services")
  })
  it("still needs a registration number to stand in for the seller VAT identifier (BR-E-02)", () => {
    const document = { ...issued(false), seller: { ...issued(false).seller, legalId: null } }
    expect(validateEinvoice(document)).toEqual(expect.arrayContaining(["seller.taxId", "seller.legalId"]))
  })
  it("keeps a VAT-registered seller's lines at standard 25 % in one breakdown, with the seller VAT ID (BT-31)", () => {
    const standard: FrozenVatGroup = { ...group("standard", null, "1300.00"), key: vatGroupKey({ treatment: "standard", country: null, reasonCode: null, rate: "0.25" }),
      rate: "0.25", tax: "325.00", gross: "1625.00", taxBase: "325.00", grossBase: "1625.00" }
    const standardLine = (lineNet: string) => ({ ...line("standard", null, lineNet), taxRate: "25", vatRateInput: "0.25" })
    const document = issued(true, { groups: [standard, group("exempt", "health", "500.00")],
      lines: [standardLine("1000"), standardLine("200"), standardLine("100"), line("exempt", "health", "500")] })
    expect(validateEinvoice(document)).toEqual([])
    const xml = buildUblDocument(document)
    const { violations, seller, taxSchemes } = exemptRuleViolations(xml)
    expect(violations).toEqual([])
    expect(taxSchemes(seller, true).map(scheme => text(scheme, "cbc:CompanyID"))).toEqual(["DK12345674"])
    expect(taxSchemes(seller, false)).toEqual([])
    const root = new DOMParser().parseFromString(xml, "application/xml").documentElement
    const taxTotal = kid(root, "cac:TaxTotal")!
    expect(kids(taxTotal, "cac:TaxSubtotal").map(subtotal => [text(subtotal, "cac:TaxCategory", "cbc:ID"), text(subtotal, "cac:TaxCategory", "cbc:Percent"),
      amount(subtotal, "cbc:TaxableAmount"), amount(subtotal, "cbc:TaxAmount")])).toEqual([["S", "25", 1300, 325], ["E", "0", 500, 0]])
    expect(amount(taxTotal, "cbc:TaxAmount")).toBe(325)
    expect(kids(root, "cac:InvoiceLine").map(invoiceLine => text(invoiceLine, "cac:Item", "cac:ClassifiedTaxCategory", "cbc:ID"))).toEqual(["S", "S", "S", "E"])
    expect(amount(kid(root, "cac:LegalMonetaryTotal")!, "cbc:TaxInclusiveAmount")).toBe(2125)
  })
  it.each([true, null])("still has no UBL category for unclassified zero when registration is %s", momsRegistered => {
    expect(isEinvoiceVatClassified(issued(momsRegistered))).toBe(false)
  })
})
