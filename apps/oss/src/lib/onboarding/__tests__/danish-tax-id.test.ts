import { describe, expect, it } from "vitest"
import { isReplacedDanishTaxId } from "../danish-tax-id"

describe("isReplacedDanishTaxId", () => {
  it("replaces mixed-case Danish schemes, including placeholders without a country", () => {
    for (const scheme of ["CVR", "cVr", "VAT", "vAt", "Dk_CvR", "dK_VaT"]) {
      expect(isReplacedDanishTaxId({ scheme, value: "old", countryCode: null })).toBe(true)
    }
    expect(isReplacedDanishTaxId({ scheme: "customer_ref", value: "old", countryCode: null })).toBe(false)
    expect(isReplacedDanishTaxId({ scheme: "vat", value: "Original ID", countryCode: null })).toBe(true)
    expect(isReplacedDanishTaxId({ scheme: "vat", value: "AI draft ID", countryCode: null })).toBe(true)
    expect(isReplacedDanishTaxId({ scheme: "vat", value: "DK24256790", countryCode: null })).toBe(true)
    expect(isReplacedDanishTaxId({ scheme: "vAt", value: "DK87654321", countryCode: null })).toBe(true)
    expect(isReplacedDanishTaxId({ scheme: "cvr", value: "24256790", countryCode: null })).toBe(true)
    expect(isReplacedDanishTaxId({ scheme: "cVr", value: "87654321", countryCode: null })).toBe(true)
  })

  it("keeps a foreign VAT id, including one saved without a country code", () => {
    expect(isReplacedDanishTaxId({ scheme: "vat", value: "DE123456789", countryCode: "DE" })).toBe(false)
    expect(isReplacedDanishTaxId({ scheme: "vat", value: "DE123456789", countryCode: null })).toBe(false)
    expect(isReplacedDanishTaxId({ scheme: "vat", value: "DK11111111", countryCode: "DK" })).toBe(true)
  })
})
