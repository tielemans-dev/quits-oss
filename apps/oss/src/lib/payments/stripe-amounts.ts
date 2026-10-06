/**
 * Stripe expresses amounts in a currency's minor unit. Most currencies have two decimals, the
 * currencies below have none, and a few legacy cases are zero-decimal in practice but must still be
 * sent with two (always `00`) decimals. See https://docs.stripe.com/currencies.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
])

/** Zero-decimal in practice, but Stripe expects two decimals that are always `00`. */
const WHOLE_UNIT_TWO_DECIMAL_CURRENCIES = new Set(["ISK", "UGX"])

export function isZeroDecimalCurrency(currency: string) {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())
}

/** Converts a major-unit amount (e.g. 12.50 USD) to Stripe's minor unit (1250). */
export function toStripeMinorUnits(amount: number, currency: string) {
  const code = currency.toUpperCase()
  if (ZERO_DECIMAL_CURRENCIES.has(code)) {
    return Math.round(amount)
  }
  if (WHOLE_UNIT_TWO_DECIMAL_CURRENCIES.has(code)) {
    return Math.round(amount) * 100
  }
  return Math.round(amount * 100)
}

/** Converts a Stripe minor-unit amount back to a major-unit amount with at most two decimals. */
export function fromStripeMinorUnits(amount: number, currency: string) {
  if (isZeroDecimalCurrency(currency)) {
    return amount
  }
  return Math.round(amount) / 100
}
