import { describe, expect, it } from "vitest"
import { localeFromAcceptLanguage } from "../accept-language"

describe("localeFromAcceptLanguage", () => {
  it("answers in the visitor's most preferred supported language", () => {
    expect(localeFromAcceptLanguage("da-DK,da;q=0.9,en;q=0.8")).toBe("da-DK")
    expect(localeFromAcceptLanguage("en-GB,en;q=0.9,da;q=0.8")).toBe("en-US")
    expect(localeFromAcceptLanguage("de-DE,de;q=0.9,da;q=0.5")).toBe("da-DK")
    expect(localeFromAcceptLanguage("en;q=0.4, da;q=0.8")).toBe("da-DK")
  })

  it("falls back to English", () => {
    expect(localeFromAcceptLanguage(undefined)).toBe("en-US")
    expect(localeFromAcceptLanguage("")).toBe("en-US")
    expect(localeFromAcceptLanguage("de-DE,fr;q=0.8")).toBe("en-US")
    expect(localeFromAcceptLanguage("*")).toBe("en-US")
    expect(localeFromAcceptLanguage("da;q=0, de")).toBe("en-US")
    expect(localeFromAcceptLanguage("da;q=oops")).toBe("en-US")
  })
})
