import { describe, expect, it } from "vitest"
import { reconcilePolicyVat } from "../invoice-defaults"

const exempt = { treatment: "exempt", rate: "0" } as const
const standard = { treatment: "standard", rate: "0.25" } as const

describe("reconcilePolicyVat", () => {
  it("leaves lines alone without a policy-fixed rate, and returns the same array when all comply", () => {
    const lines = [{ vat: exempt }]
    expect(reconcilePolicyVat(lines, { standardVatRate: null })).toBe(lines)
    const compliant = [{ vat: standard }, {}]
    expect(reconcilePolicyVat(compliant, { standardVatRate: "25", momsRegistered: true })).toBe(compliant)
  })
  it("drops classifications a registered seller's mandatory rate cannot honour", () => {
    expect(reconcilePolicyVat([{ vat: exempt }, { vat: { treatment: "standard", rate: "0.2" } }, { vat: standard }], { standardVatRate: "25", momsRegistered: true }))
      .toEqual([{ vat: undefined }, { vat: undefined }, { vat: standard }])
  })
  it("keeps only zero-rate treatments for a seller that is not VAT-registered", () => {
    expect(reconcilePolicyVat([{ vat: standard }, { vat: { treatment: "out_of_scope", rate: "0" } }], { standardVatRate: "25", momsRegistered: false }))
      .toEqual([{ vat: undefined }, { vat: { treatment: "out_of_scope", rate: "0" } }])
  })
})
