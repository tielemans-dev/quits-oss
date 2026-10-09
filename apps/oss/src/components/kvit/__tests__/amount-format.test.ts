import { describe, expect, it } from "vitest"

import {
  decimalFromNumber,
  formatAmountParts,
  formatAmountText,
  minorToDecimal,
} from "../amount-format"

// Intl separates the number and the currency with a no-break space.
const nbsp = " "

describe("minorToDecimal", () => {
  it("moves the point in the digits", () => {
    expect(minorToDecimal(560000, 2)).toBe("5600.00")
    expect(minorToDecimal(5, 2)).toBe("0.05")
    expect(minorToDecimal(-5, 2)).toBe("-0.05")
    expect(minorToDecimal(123, 0)).toBe("123")
    expect(minorToDecimal(1234567, 3)).toBe("1234.567")
  })

  it("is exact beyond double precision", () => {
    expect(minorToDecimal(12345678901234567890n, 2)).toBe("123456789012345678.90")
  })

  it("rejects an unsafe integer", () => {
    expect(() => minorToDecimal(2 ** 60, 2)).toThrow(RangeError)
  })
})

describe("decimalFromNumber", () => {
  it("writes an API number at the currency precision", () => {
    expect(decimalFromNumber(5600, "DKK")).toBe("5600.00")
    expect(decimalFromNumber(1234.5, "DKK")).toBe("1234.50")
    expect(decimalFromNumber(1500, "JPY")).toBe("1500")
    expect(decimalFromNumber(-1850, "DKK")).toBe("-1850.00")
  })

  it("writes a rounded negative zero as zero", () => {
    expect(decimalFromNumber(-0.001, "DKK")).toBe("0.00")
    expect(decimalFromNumber(-0, "DKK")).toBe("0.00")
    expect(decimalFromNumber(-0.4, "JPY")).toBe("0")
    expect(formatAmountText(decimalFromNumber(-0.001, "DKK"), "DKK", "da-DK")).toBe(`0,00${nbsp}kr.`)
  })

  it("holds the Decimal(12,2) range and gives up beyond it", () => {
    expect(decimalFromNumber(9_999_999_999.99, "DKK")).toBe("9999999999.99")
    expect(decimalFromNumber(-9_999_999_999.99, "DKK")).toBe("-9999999999.99")
    expect(decimalFromNumber(10_000_000_000, "DKK")).toBeNull()
  })

  it("returns null for a number that is not finite or would be written in exponent notation", () => {
    expect(decimalFromNumber(Number.NaN, "DKK")).toBeNull()
    expect(decimalFromNumber(Number.POSITIVE_INFINITY, "DKK")).toBeNull()
    expect(decimalFromNumber(1e21, "DKK")).toBeNull()
    expect(decimalFromNumber(1e-7, "DKK")).toBe("0.00")
  })

  it("shows an em dash for null instead of throwing", () => {
    expect(formatAmountText(null, "DKK", "da-DK")).toBe("—")
  })
})

describe("formatAmountParts", () => {
  it("splits a Danish amount so the fraction can be raised", () => {
    const parts = formatAmountParts("48250.00", "DKK", "da-DK")
    expect(parts.filter((p) => p.type === "fraction").map((p) => p.value)).toEqual(["00"])
    expect(parts.filter((p) => p.type === "decimal").map((p) => p.value)).toEqual([","])
    expect(parts.map((p) => p.value).join("")).toBe(`48.250,00${nbsp}kr.`)
  })

  it("accepts minor units and a decimal string alike", () => {
    expect(formatAmountText({ minor: 560000 }, "DKK", "da-DK")).toBe(`5.600,00${nbsp}kr.`)
    expect(formatAmountText("5600.00", "DKK", "da-DK")).toBe(`5.600,00${nbsp}kr.`)
  })

  it("follows the locale: an English reader gets English separators", () => {
    expect(formatAmountText("5600.00", "USD", "en-US")).toBe("$5,600.00")
  })

  it("has no fraction part for a currency without minor units", () => {
    const parts = formatAmountParts("1500", "JPY", "en-US")
    expect(parts.some((p) => p.type === "fraction")).toBe(false)
  })

  it("formats a negative amount", () => {
    expect(formatAmountText("-1850.00", "DKK", "da-DK")).toContain("1.850,00")
    expect(formatAmountText("-1850.00", "DKK", "da-DK")).toMatch(/^[-−]/)
  })

  it("rejects something that is not a decimal", () => {
    expect(() => formatAmountParts("12,5", "DKK", "da-DK")).toThrow(RangeError)
    expect(() => formatAmountParts("1e3", "DKK", "da-DK")).toThrow(RangeError)
  })
})

describe("stated precision", () => {
  const text = (value: string, currency: string, precision?: { exponent: number; source?: "storage" }) =>
    formatAmountText(value, currency, "da-DK", precision)

  it("writes a storage-precision amount with two decimals and the ISO code, whatever Intl thinks", () => {
    // Intl treats CLP and JPY as whole-unit currencies and would round 75.50 to 76.
    expect(text("75.50", "CLP")).toBe("76" + nbsp + "CLP")
    expect(text("75.50", "CLP", { exponent: 2, source: "storage" })).toBe("75,50" + nbsp + "CLP")
    expect(text("1500.25", "JPY", { exponent: 2, source: "storage" })).toBe("1.500,25" + nbsp + "JPY")
    expect(text("12.50", "ZZZ", { exponent: 2, source: "storage" })).toBe("12,50" + nbsp + "ZZZ")
  })

  it("uses the code, not a symbol, for a storage-precision currency Intl knows by symbol", () => {
    expect(text("12.50", "USD", { exponent: 2, source: "storage" })).toBe("12,50" + nbsp + "USD")
  })

  it("writes exactly the stated number of decimals for a known exponent", () => {
    expect(text("12345.678", "BHD", { exponent: 3 })).toBe("12.345,678" + nbsp + "BHD")
    expect(text("1500", "JPY", { exponent: 0 })).toBe("1.500" + nbsp + "JP¥")
  })

  it("splits the fraction of a stated precision for the raised cents", () => {
    const parts = formatAmountParts("75.50", "CLP", "da-DK", { exponent: 2, source: "storage" })
    expect(parts.filter((part) => part.type === "fraction").map((part) => part.value)).toEqual(["50"])
  })

  it("leaves an amount without a stated precision as it was", () => {
    expect(text("12.50", "DKK")).toBe("12,50" + nbsp + "kr.")
  })

  it("reads minor units at the stated exponent", () => {
    expect(formatAmountText({ minor: 7550 }, "CLP", "da-DK", { exponent: 2, source: "storage" })).toBe("75,50" + nbsp + "CLP")
  })
})
