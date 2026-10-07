import { describe, expect, it } from "vitest"
import { validateDocument } from "../validate"
import { resolveCountryProfile } from "../registry"

describe("validateDocument", () => {
  it("requires at least one seller tax id for Denmark", () => {
    const dk = resolveCountryProfile("DK")
    const result = validateDocument(dk, {
      sellerTaxIds: [],
      buyerTaxIds: [],
      taxRate: 25,
    })

    expect(result.some((item) => item.code === "MISSING_SELLER_TAX_ID")).toBe(true)
  })

  it("does not require seller tax id for US profile", () => {
    const us = resolveCountryProfile("US")
    const result = validateDocument(us, {
      sellerTaxIds: [],
      buyerTaxIds: [],
      taxRate: 8,
    })

    expect(result).toHaveLength(0)
  })

  it("warns without blocking when the country has no module", () => {
    const result = validateDocument(resolveCountryProfile("GB"), {
      sellerTaxIds: [],
      buyerTaxIds: [],
      taxRate: 20,
    })

    expect(result).toEqual([expect.objectContaining({ code: "UNSUPPORTED_COUNTRY", severity: "warning" })])
  })

  it("still applies the regime to a member country without a module", () => {
    const result = validateDocument(resolveCountryProfile("PL"), {
      sellerTaxIds: [],
      buyerTaxIds: [],
      taxRate: 23,
    })

    expect(result.map((item) => item.code)).toEqual(["MISSING_SELLER_TAX_ID", "UNSUPPORTED_COUNTRY"])
  })
})
