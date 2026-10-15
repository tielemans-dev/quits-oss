import { describe, expect, it } from "vitest"
import { vatRowsByRate } from "../../../domain/documents/frozen-vat-groups"
import { buildTotals } from "../totals"

const group = { rate: "0", net: "10", tax: "0", gross: "10", treatment: "exempt", reasonCode: "health" }
const totals = (groups: Parameters<typeof vatRowsByRate>[0], locale = "en-US") => buildTotals({ basis: "net", subtotal: "20", taxAmount: "0", total: "20", currency: "DKK", locale, vatRows: vatRowsByRate(groups, "DKK") })

describe("QUI-9 review regressions", () => {
  it("preserves distinct frozen statements and reason codes at the same rate", () => {
    const result = totals([
      { ...group, evidence: { statementText: "Section <13> health" } },
      { ...group, reasonCode: "education", evidence: { statementText: "Section 13 education" } },
    ])
    expect(result.lines[1]?.reason).toBe("Exempt · Health · Education · Section <13> health · Section 13 education")
    expect(result.lines[1]?.amount).toBe("0.00")
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
