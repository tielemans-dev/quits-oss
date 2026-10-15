import { describe, expect, it } from "vitest"
import { frozenVatGroups, vatRowsByRate } from "../../../domain/documents/frozen-vat-groups"
import { buildTotals } from "../totals"

const group = { rate: "0", net: "10", tax: "0", gross: "10", treatment: "exempt", reasonCode: "health" }
const totals = (groups: Parameters<typeof vatRowsByRate>[0], locale = "en-US") => buildTotals({ basis: "net", subtotal: "20", taxAmount: "0", total: "20", currency: "DKK", locale, vatRows: vatRowsByRate(groups, "DKK") })

describe("QUI-9 review regressions", () => {
  it("preserves distinct frozen statements and reason codes at the same rate", () => {
    const result = totals([
      { ...group, evidence: { statementText: "Section <13> health" } },
      { ...group, reasonCode: "education", evidence: { statementText: "Section 13 education" } },
    ])
    expect(result.lines[1]?.reason).toBe("Exempt · Health · Section <13> health")
    expect(result.lines[2]?.reason).toBe("Exempt · Education · Section 13 education")
    expect(result.lines[1]?.amount).toBe("0.00")
  })

  it("keeps unlike zero treatments and their taxable amounts separate", () => {
    const rows = vatRowsByRate([group, { ...group, net: "20", gross: "20", treatment: "intra_community", reasonCode: "goods" }, { ...group, net: "30", gross: "30", treatment: "export", reasonCode: "goods" }], "DKK")
    expect(rows.map(row => [row.treatment, row.net])).toEqual([["exempt", "10.00"], ["intra_community", "20.00"], ["export", "30.00"]])
  })

  it("limits document evidence to non-standard groups and ignores legacy standard evidence", () => {
    const groups = frozenVatGroups({ currency: "DKK", vatEvidence: { statementText: "Synthetic health exemption" }, items: [
      { vatTreatment: "standard", vatReasonCode: null, vatCountry: "DK", taxRate: "25", lineNet: "100", lineTax: "25", lineGross: "125" },
      { vatTreatment: "exempt", vatReasonCode: "health", vatCountry: "DK", taxRate: "0", lineNet: "10", lineTax: "0", lineGross: "10" },
    ] })
    expect(groups.find(group => group.treatment === "standard")?.evidence).toBeUndefined()
    const result = totals(groups.map(group => ({ ...group, evidence: { statementText: "Synthetic health exemption" } })))
    expect(result.lines.find(line => line.label === "Tax 25% of DKK 100.00")?.reason).toBeUndefined()
    expect(result.lines.find(line => line.reason?.includes("Synthetic health exemption"))?.label).toContain("0%")
    expect(result.lines.filter(line => line.reason?.includes("Synthetic health exemption"))).toHaveLength(1)
  })

  it("keeps the existing mixed scope note for unfinished draft previews", () => {
    expect(totals([{ ...group, treatment: "out_of_scope", reasonCode: null }, { ...group, rate: "0.25", treatment: "standard", reasonCode: null }]).note).toBeDefined()
  })

  it.each(["da-DK", "en-US"])("does not claim an unclassified zero line is outside scope in %s", locale => {
    expect(totals([{ ...group, treatment: "out_of_scope", reasonCode: null }, { ...group, treatment: "unclassified_zero", reasonCode: null }], locale).note).toBeUndefined()
    const note = totals([{ ...group, treatment: "out_of_scope", reasonCode: null }], locale).note
    expect(note).toBeDefined()
    expect(note).not.toMatch(/Danish|Danmark/)
  })

  it("uses generic English labels for positive tax without a regime contract", () => {
    const result = totals([{ ...group, rate: "0.08", treatment: "standard", tax: "0.8", gross: "10.8" }])
    expect(result.lines[0]?.label).toBe("Subtotal excl. tax")
    expect(result.lines[1]?.label).toBe("Tax 8%")
    expect(result.total.label).toBe("Total incl. tax")
  })

})
