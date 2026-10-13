import { describe, expect, it } from "vitest"
import { formatCurrency, formatDate, formatNumber, formatShortDate } from "../format"

describe("i18n format helpers", () => {
  it.each([
    ["da-DK", "11. okt. 2026", "11. oktober 2026"],
    ["en-US", "Oct 11, 2026", "October 11, 2026"],
  ])("uses a short UI date and an explicit long PDF date in %s", (locale, short, long) => {
    expect(formatDate("2026-10-11T12:00:00Z", locale, "UTC")).toBe(short)
    expect(formatDate("2026-10-11T12:00:00Z", locale, "UTC", { month: "long" })).toBe(long)
  })

  it("keeps calendar days in UTC and instants in their display zone", () => {
    expect(formatDate("2026-10-11", "da-DK", "UTC")).toBe("11. okt. 2026")
    expect(formatDate("2026-10-11T00:00:00Z", "da-DK", "America/New_York")).toBe("10. okt. 2026")
  })

  it("formats quote dates day first with a short month in both languages", () => {
    expect(formatShortDate("2026-10-11T12:00:00Z", "da-DK", "Europe/Copenhagen")).toBe("11. okt. 2026")
    expect(formatShortDate("2026-10-11T12:00:00Z", "en-US", "UTC")).toBe("11 Oct 2026")
    expect(formatShortDate("2026-10-11T00:00:00Z", "en-US", "America/New_York")).toBe("10 Oct 2026")
  })
  it.each(["de-DE", "fr-FR", "nl-NL"])("preserves the configured short month for %s", locale => {
    expect(formatShortDate("2026-10-11T12:00:00Z", locale, "UTC")).toBe(formatDate("2026-10-11T12:00:00Z", locale, "UTC", { month: "short" }))
  })
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
