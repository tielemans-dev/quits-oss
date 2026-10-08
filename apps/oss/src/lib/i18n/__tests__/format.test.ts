import { describe, expect, it } from "vitest"
import { formatCurrency, formatDate, formatNumber } from "../format"

describe("i18n format helpers", () => {
  it("formats US currency with en-US locale", () => {
    expect(formatCurrency(1234.56, "USD", "en-US")).toBe("$1,234.56")
  })

  it("formats DKK with da-DK locale", () => {
    expect(formatCurrency(1234.56, "DKK", "da-DK")).toContain("1.234,56")
  })

  it("formats dates differently for da-DK and en-US", () => {
    const date = "2026-02-26T00:00:00.000Z"
    const us = formatDate(date, "en-US", "UTC")
    const dk = formatDate(date, "da-DK", "UTC")

    expect(us).not.toBe(dk)
  })

  it("formats DKK with the Danish separators and currency suffix", () => {
    expect(formatCurrency(1250, "DKK", "da-DK")).toBe("1.250,00\u00a0kr.")
  })

  it("formats a quantity with the locale's decimal separator", () => {
    expect(formatNumber(1.5, "en-US")).toBe("1.5")
    expect(formatNumber(1.5, "da-DK")).toBe("1,5")
    expect(formatNumber(2, "da-DK")).toBe("2")
  })
})
