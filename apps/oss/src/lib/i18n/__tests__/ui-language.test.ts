// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { resolveUiLanguage, saveUiLanguage, uiLocale } from "../ui-language"

afterEach(() => {
  document.cookie = "quits-lang=; path=/; max-age=0"
})

describe("interface language", () => {
  it("takes ?lang first, then the saved choice, and always knows the browser's", () => {
    expect(resolveUiLanguage({ search: { lang: "en" }, cookie: "a=1; quits-lang=da", acceptLanguage: "da" })).toEqual({ chosen: "en", browser: "da-DK" })
    expect(resolveUiLanguage({ search: {}, cookie: "a=1; quits-lang=da", acceptLanguage: "en-GB,en;q=0.8" })).toEqual({ chosen: "da", browser: "en-US" })
    expect(resolveUiLanguage({ search: { lang: "xx" }, cookie: "quits-lang=de", acceptLanguage: "da-DK,da;q=0.9" })).toEqual({ chosen: undefined, browser: "da-DK" })
    // Neither language preferred, or no header at all: English.
    expect(resolveUiLanguage({ acceptLanguage: "de-DE" })).toEqual({ chosen: undefined, browser: "en-US" })
    expect(resolveUiLanguage({})).toEqual({ chosen: undefined, browser: "en-US" })
  })

  it("puts a choice over the organization's locale, and the organization's over the browser's", () => {
    expect(uiLocale({ chosen: "en", browser: "da-DK" }, "da-DK")).toBe("en-US")
    expect(uiLocale({ chosen: "da", browser: "en-US" }, "en-US")).toBe("da-DK")
    expect(uiLocale({ browser: "en-US" }, "da-DK")).toBe("da-DK")
    expect(uiLocale({ browser: "da-DK" })).toBe("da-DK")
    expect(uiLocale({ chosen: "en", browser: "da-DK" })).toBe("en-US")
    expect(uiLocale(undefined, "de-DE")).toBe("de-DE")
    expect(uiLocale(undefined)).toBeUndefined()
  })

  it("keeps the organization's regional locale when it speaks the chosen language", () => {
    expect(uiLocale({ chosen: "en", browser: "da-DK" }, "en-GB")).toBe("en-GB")
  })

  it("saves the choice where the server reads it", () => {
    saveUiLanguage("da")
    expect(resolveUiLanguage({ cookie: document.cookie }).chosen).toBe("da")
  })
})
