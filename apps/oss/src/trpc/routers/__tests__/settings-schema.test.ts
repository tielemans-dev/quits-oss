import { describe, expect, it } from "vitest"
import { settingsUpdateSchema } from "../settings"

describe("settingsUpdateSchema", () => {
  it("accepts global locale and compliance fields", () => {
    const parsed = settingsUpdateSchema.parse({
      countryCode: "DK",
      locale: "da-DK",
      timezone: "Europe/Copenhagen",
      defaultCurrency: "DKK",
      taxRegime: "eu_vat",
      pricesIncludeTax: true,
      aiOpenRouterModel: "openai/gpt-4o-mini",
      aiOpenRouterApiKey: "sk-or-v1-example-key-1234567890",
    })

    expect(parsed.countryCode).toBe("DK")
    expect(parsed.defaultCurrency).toBe("DKK")
    expect(parsed.pricesIncludeTax).toBe(true)
    expect(parsed.aiOpenRouterModel).toBe("openai/gpt-4o-mini")
  })

  it("accepts countries without a module so their organizations can still save settings", () => {
    expect(settingsUpdateSchema.parse({ countryCode: "gb" }).countryCode).toBe("GB")
    for (const countryCode of ["ZZ", "EU", "XX"]) {
      expect(() => settingsUpdateSchema.parse({ countryCode })).toThrow()
    }
  })

  it("accepts any formattable locale, so locales chosen at setup can be saved", () => {
    expect(settingsUpdateSchema.parse({ locale: "pl-PL" }).locale).toBe("pl-PL")
    expect(settingsUpdateSchema.parse({ locale: "en-us" }).locale).toBe("en-US")
    expect(settingsUpdateSchema.parse({ locale: "es-419" }).locale).toBe("es-419")
    expect(settingsUpdateSchema.parse({ locale: "en-208" }).locale).toBe("en-DK")
    for (const locale of ["foo", "xx-YY", "en-000", "en-999", ""]) {
      expect(() => settingsUpdateSchema.parse({ locale })).toThrow()
    }
  })

  it("rejects unsupported tax regime", () => {
    expect(() =>
      settingsUpdateSchema.parse({
        taxRegime: "bad_regime",
      })
    ).toThrow()
  })

  it("accepts company logo as URL or uploaded image data", () => {
    const urlLogo = settingsUpdateSchema.parse({
      companyLogo: "https://cdn.example.com/logo.png",
    })
    const dataLogo = settingsUpdateSchema.parse({
      companyLogo: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA",
    })

    expect(urlLogo.companyLogo).toBe("https://cdn.example.com/logo.png")
    expect(dataLogo.companyLogo?.startsWith("data:image/png;base64,")).toBe(true)
  })

  it("rejects invalid company logo value", () => {
    expect(() =>
      settingsUpdateSchema.parse({
        companyLogo: "not-a-logo",
      })
    ).toThrow()
  })

  it("rejects unsupported locale/timezone", () => {
    expect(() =>
      settingsUpdateSchema.parse({
        locale: "en-XX",
      })
    ).toThrow()

    expect(() =>
      settingsUpdateSchema.parse({
        timezone: "Mars/OlympusMons",
      })
    ).toThrow()
  })
})
