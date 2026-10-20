import { describe, expect, it } from "vitest"
import { formatIsoDateForInputDisplay, parseLocalizedDateInput } from "../date-input"

describe("date input locale formatting", () => {
  it("formats ISO dates in locale-specific order", () => {
    const isoDate = "2026-03-02"

    expect(formatIsoDateForInputDisplay(isoDate, "da-DK")).toMatch(/^02[./-]03[./-]2026$/)
    expect(formatIsoDateForInputDisplay(isoDate, "en-US")).toMatch(/^03[./-]02[./-]2026$/)
  })

  it("returns original value when date is not ISO format", () => {
    expect(formatIsoDateForInputDisplay("02/03/2026", "da-DK")).toBe("02/03/2026")
  })

  it("returns original value when ISO date is invalid", () => {
    expect(formatIsoDateForInputDisplay("2026-02-31", "da-DK")).toBe("2026-02-31")
  })
})

describe("typed dates", () => {
  it.each([["20.10.2026", "2026-10-20"], ["20/10/2026", "2026-10-20"], ["20-10-26", "2026-10-20"], ["1.2.2026", "2026-02-01"], [" 20.10.2026. ", "2026-10-20"], ["2026-10-20", "2026-10-20"]])("reads %j in Danish order", (typed, iso) => {
    expect(parseLocalizedDateInput(typed, "da-DK")).toBe(iso)
  })

  it("reads month first where the locale writes it first", () => {
    expect(parseLocalizedDateInput("10/20/2026", "en-US")).toBe("2026-10-20")
    expect(parseLocalizedDateInput("10/20/2026", "da-DK")).toBeNull()
  })

  it.each(["", "20.10", "31.02.2026", "20.13.2026", "abc", "20.10.202", "2026.10.20.1"])("rejects %j", typed => {
    expect(parseLocalizedDateInput(typed, "da-DK")).toBeNull()
  })

  it("reads back what it displays", () => {
    for (const locale of ["da-DK", "en-US", "en-GB"]) expect(parseLocalizedDateInput(formatIsoDateForInputDisplay("2026-03-02", locale), locale)).toBe("2026-03-02")
  })
})
