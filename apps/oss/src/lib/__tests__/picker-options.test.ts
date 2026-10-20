import { describe, expect, it } from "vitest"
import { countryPickerOptions, CURRENCY_CODES, currencyPickerOptions, localeDisplayName, localePickerOptions } from "../picker-options"
import { translate } from "../i18n/translate"

const labels = (options: Array<{ label: string }>) => options.map((option) => option.label)

describe("picker options", () => {
  it("names document locales in the UI language instead of showing codes", () => {
    expect(labels(localePickerOptions("da-DK", "DK", "da-DK"))).toEqual([
      "Dansk (Danmark)",
      "Amerikansk engelsk",
      "Britisk engelsk",
      "Europæisk spansk",
      "Fransk (Frankrig)",
      "Nederlandsk (Nederlandene)",
      "Tysk (Tyskland)",
    ])
    expect(localeDisplayName("en-GB", "en-US")).toBe("British English")
    expect(labels(localePickerOptions("de-DE", "DE", "en-US"))[0]).toBe("German (Germany)")
  })

  it("puts a Danish organization's country first, then sorts countries by their Danish names", () => {
    expect(labels(countryPickerOptions("DK", "DK", "da-DK"))).toEqual(["Danmark", "Frankrig", "Nederlandene", "Tyskland", "USA"])
    expect(labels(countryPickerOptions("DK", "DK", "en-US"))).toEqual(["Denmark", "France", "Germany", "Netherlands", "United States"])
  })

  it("keeps an unsupported current country in the sorted list", () => {
    expect(countryPickerOptions("SE", "SE", "da-DK").map((option) => option.value)).toEqual(["SE", "DK", "FR", "NL", "DE", "US"])
  })

  it("puts the organization country's currency first, then sorts by name in the UI language", () => {
    const name = (locale: string) => (code: string) => translate(`auth.onboarding.currency.${code}` as Parameters<typeof translate>[0], locale)
    expect(currencyPickerOptions(CURRENCY_CODES, "DK", "da-DK", name("da-DK")).map((option) => option.value)).toEqual(["DKK", "USD", "AUD", "GBP", "CAD", "EUR"])
    expect(currencyPickerOptions(CURRENCY_CODES, "DE", "en-US", name("en-US")).map((option) => option.value)).toEqual(["EUR", "AUD", "GBP", "CAD", "DKK", "USD"])
    expect(currencyPickerOptions(CURRENCY_CODES, null, "en-US", name("en-US"))[0]?.value).toBe("AUD")
  })
})
