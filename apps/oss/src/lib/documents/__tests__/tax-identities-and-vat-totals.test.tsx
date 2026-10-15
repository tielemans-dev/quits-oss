import { describe, expect, it } from "vitest"
import { formatTaxIds, distinctCompany } from "../tax-ids"
import { buildTotals } from "../totals"
import { pdfBuyerAddress } from "../invoice-identity"
import { deviationVatLabel, type VatRow } from "../line-amounts"
import { agreementVatPresentation } from "../../agreements/vat-presentation"
import { vatRowsByRate } from "../../../domain/documents/frozen-vat-groups"

const ids = [{ scheme: "vat", value: "DK12345678", countryCode: "DK" }]
const zero = { ratePercent: "0", net: "100", tax: "0", gross: "100", treatment: "out_of_scope" }
const standard = { ratePercent: "25", net: "200", tax: "50", gross: "250", treatment: "standard" }
const totals = (vatRows: readonly VatRow[], locale = "da-DK") => buildTotals({ basis: "net", subtotal: "300", taxAmount: "50", total: "350", currency: "DKK", locale, vatRows })
describe("Tax identities and VAT totals", () => {
  it.each([["da-DK", "CVR-nr. 12345678", "Momsnr. DK12345678"], ["en-US", "CVR no. 12345678", "VAT no. DK12345678"]])("labels seller IDs by buyer country in %s", (locale, domestic, foreign) => {
    expect(formatTaxIds(ids, locale, "DK", true)).toEqual([domestic])
    expect(formatTaxIds(ids, locale, "SE", true)).toEqual([foreign])
    expect(formatTaxIds([{ scheme: "cvr", value: "12345678" }], locale, "SE", false)).toEqual([domestic])
    expect(formatTaxIds([{ scheme: "cvr", value: "12345678" }], locale, "US", true)).toEqual([foreign])
  })
  it("prints a company once and keeps Danish postal order", () => {
    expect(distinctCompany({ name: "Buyer", company: " Buyer " })).toBeNull()
    expect(distinctCompany({ name: "Buyer", company: " " })).toBeNull()
    expect(distinctCompany({ name: "Buyer", company: "Buyer ApS" })).toBe("Buyer ApS")
    expect(pdfBuyerAddress({ name: "Buyer", city: "København N", zip: "2200", country: "DK" })).toContain("2200 København N")
  })
  it("uses VAT-side labels on net documents and preserves mixed bases", () => {
    const result = totals([zero, standard])
    expect(result.lines[0]?.label).toBe("Subtotal ekskl. moms")
    expect(result.total.label).toBe("Total inkl. moms")
    expect(result.lines[1]).toMatchObject({ label: "Moms 0 % af 100,00\u00a0kr.", amount: "0", reason: "Uden for momsens anvendelsesområde" })
    expect(result.note).toBe("Linjer markeret 0 % moms er uden for momsens anvendelsesområde.")
    expect(deviationVatLabel(0, [zero, standard])).toBe("pdf.lineVatRate")
    expect(deviationVatLabel(25, [zero, standard])).toBeNull()
    expect(deviationVatLabel(5, [standard], 25)).toBe("pdf.lineVatRate")
  })
  it("retains a lone classified zero row with plain totals and approved wording", () => {
    const result = totals([zero], "en-US")
    expect(result.lines.map(row => row.label)).toEqual(["Subtotal", "Tax 0%"])
    expect(result.total.label).toBe("Total")
    expect(result.note).toBe("No VAT is charged. The supply is outside the scope of VAT.")
    expect(totals([{ ...zero, treatment: "exempt" }]).lines[1]?.reason).toBe("Momsfritaget")
    expect(totals([{ ...zero, treatment: "exempt" }]).note).toBeUndefined()
  })
  it("keeps taxable amounts separate for unlike treatments at one rate", () => {
    const rows = vatRowsByRate(["out_of_scope", "exempt"].map(treatment => ({ rate: "0", net: "10", tax: "0", gross: "10", treatment })), "DKK")
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.net)).toEqual(["10.00", "10.00"])
    expect(totals(rows).note).toBeUndefined()
    expect(totals(rows).lines[1]?.reason).toBe("Uden for momsens anvendelsesområde")
    expect(totals(rows).lines[2]?.reason).toBe("Momsfritaget")
  })
  it.each(["export", "zero_rated"])("retains a lone %s zero row with its classification", treatment => {
    const result = totals([{ ...zero, treatment }], "en-US")
    expect(result.lines.map(row => row.label)).toEqual(["Subtotal", "Tax 0%"])
    expect(result.lines[1]?.reason).toBe(treatment === "export" ? "VAT-exempt export under section 34(1)(5) of the Danish VAT Act (momsloven)" : "Exempt from VAT")
  })
  it("still drops a lone unclassified zero row", () => {
    expect(totals([{ ...zero, treatment: "unclassified_zero" }], "en-US").lines.map(row => row.label)).toEqual(["Subtotal"])
  })
  it("treats Danish country names as domestic when labelling seller IDs", () => {
    for (const country of ["DK", "dk", "Danmark", "Denmark", " Denmark "]) expect(formatTaxIds(ids, "da-DK", country, true)).toEqual(["CVR-nr. 12345678"])
    expect(formatTaxIds(ids, "da-DK", "Sverige", true)).toEqual(["Momsnr. DK12345678"])
  })
  it("localizes a fractional line VAT rate", () => {
    const snapshot = { offerFormatVersion: 2, locale: "da-DK", currency: "DKK", taxRate: "25", taxRegime: "eu_vat", sellerSnapshot: { momsRegistered: true }, vatGroups: [], serviceTotal: { net: "0", tax: "0", gross: "0", payableRounding: "0" } }
    expect(agreementVatPresentation(snapshot as never).lineLabel("5.5")).toBe("5,5 % moms")
  })
  it("treats a blank buyer country as missing, so a paired Danish ID prints once as CVR", () => {
    const paired = [{ scheme: "cvr", value: "12345678" }, { scheme: "vat", value: "DK12345678", countryCode: "DK" }]
    for (const country of ["", "  "]) expect(formatTaxIds(paired, "da-DK", country)).toEqual(["CVR-nr. 12345678"])
  })
  it("keeps the out-of-scope note free of any one country's VAT", () => {
    expect(totals([zero], "da-DK").note).toBe("Der er ikke beregnet moms. Leverancen er uden for momsens anvendelsesområde.")
  })
})
