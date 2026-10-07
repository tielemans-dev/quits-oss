/** ISO 4217 minor-unit exponents. Unknown currencies are deliberately unsupported. */
export const currencyExponents = {
  DKK: 2, EUR: 2, USD: 2, CAD: 2, AUD: 2, GBP: 2, SEK: 2, NOK: 2, CHF: 2, PLN: 2, CZK: 2,
  JPY: 0, HUF: 2, ISK: 0,
  KWD: 3, BHD: 3, JOD: 3, OMR: 3, TND: 3,
} as const

export class CurrencyPrecisionUnsupported extends Error {
  readonly code = "currency_precision_unsupported"
  constructor(readonly currency: string) {
    super(`Unsupported currency precision: ${currency}`)
    this.name = "CurrencyPrecisionUnsupported"
  }
}
export function getCurrencyExponent(currency: string): number | undefined {
  return Object.hasOwn(currencyExponents, currency)
    ? currencyExponents[currency as keyof typeof currencyExponents]
    : undefined
}
export function requireCurrencyExponent(currency: string): 0 | 1 | 2 {
  const exponent = getCurrencyExponent(currency)
  if (exponent === undefined || exponent > 2) throw new CurrencyPrecisionUnsupported(currency)
  return exponent as 0 | 1 | 2
}
