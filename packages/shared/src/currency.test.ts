import { expect, it } from "vitest"
import { currencyExponents, CurrencyPrecisionUnsupported, getCurrencyExponent, requireCurrencyExponent } from "./currency"

it("uses ISO exponents, including HUF 2, JPY/ISK 0 and the common unsupported 3-decimal currencies", () => {
  for (const currency of ["DKK", "EUR", "USD", "CAD", "AUD", "GBP", "SEK", "NOK", "CHF", "PLN", "CZK", "HUF"]) expect(requireCurrencyExponent(currency)).toBe(2)
  for (const currency of ["JPY", "ISK"]) expect(requireCurrencyExponent(currency)).toBe(0)
  for (const currency of ["KWD", "BHD", "JOD", "OMR", "TND"]) {
    expect(getCurrencyExponent(currency)).toBe(3)
    expect(() => requireCurrencyExponent(currency)).toThrow(CurrencyPrecisionUnsupported)
  }
  for (const currency of ["XXX", "USD ", "usd", "toString"]) {
    expect(getCurrencyExponent(currency)).toBeUndefined()
    expect(() => requireCurrencyExponent(currency)).toThrow(expect.objectContaining({ code: "currency_precision_unsupported" }))
  }
  expect(Object.keys(currencyExponents)).toHaveLength(19)
})
