import { describe, expect, it } from "vitest"
import { resolveLanguage, translate } from "../translate"

describe("i18n translate", () => {
  it("resolves supported language from locale", () => {
    expect(resolveLanguage("da-DK")).toBe("da")
    expect(resolveLanguage("en-US")).toBe("en")
    expect(resolveLanguage("fr-FR")).toBe("en")
  })

  it("returns danish translation when locale is da", () => {
    expect(translate("nav.dashboard", "da-DK")).toBe("Overblik")
  })

  it("falls back to english translation", () => {
    expect(translate("nav.dashboard", "fr-FR")).toBe("Dashboard")
  })

  it("interpolates variables", () => {
    expect(translate("auth.welcome", "da-DK", { name: "Martin" })).toBe(
      "Velkommen, Martin"
    )
  })
})
