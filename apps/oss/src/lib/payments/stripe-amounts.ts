/**
 * Stripe expresses amounts in a currency's minor unit. Most currencies have two decimals, the
 * currencies below have none or three, and a few legacy cases are zero-decimal in practice but
 * must still be sent with two (always `00`) decimals. See https://docs.stripe.com/currencies.
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

/** Three-decimal currencies; Stripe expects thousandths whose last digit is `0`. */
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "JOD", "KWD", "OMR", "TND"])

export function isZeroDecimalCurrency(currency: string) {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())
}

/** How many decimals an amount in the currency can carry (JPY: 0, USD: 2, KWD: 3). */
export function currencyFractionDigits(currency: string) {
  const code = currency.toUpperCase()
  if (ZERO_DECIMAL_CURRENCIES.has(code) || WHOLE_UNIT_TWO_DECIMAL_CURRENCIES.has(code)) {
    return 0
  }
  return THREE_DECIMAL_CURRENCIES.has(code) ? 3 : 2
}

function hasAtMostDecimals(amount: number, digits: number) {
  if (!Number.isFinite(amount)) return false
  const rounded = Number(amount.toFixed(digits))
  // Tolerate binary floating point noise (0.1 + 0.2), never a real fraction of the minor unit.
  const tolerance = Math.min(1e-9 * Math.max(1, Math.abs(amount)), 10 ** -digits / 1000)
  return Math.abs(amount - rounded) < tolerance
}

/**
 * Whether a major-unit amount can be charged in the currency without rounding, e.g. 100.49 JPY
 * cannot because yen have no minor unit.
 */
export function isExactInCurrency(amount: number, currency: string) {
  return hasAtMostDecimals(amount, currencyFractionDigits(currency))
}

/**
 * Converts a major-unit amount (e.g. 12.50 USD) to Stripe's minor unit (1250). Throws a
 * `RangeError` for an amount the currency cannot represent; it never rounds money away.
 */
export function toStripeMinorUnits(amount: number, currency: string) {
  if (!isExactInCurrency(amount, currency)) {
    throw new RangeError(
      `${amount} ${currency.toUpperCase()} has more than ${currencyFractionDigits(currency)} decimals`
    )
  }
  const code = currency.toUpperCase()
  if (ZERO_DECIMAL_CURRENCIES.has(code)) {
    return Math.round(amount)
  }
  if (WHOLE_UNIT_TWO_DECIMAL_CURRENCIES.has(code)) {
    return Math.round(amount) * 100
  }
  if (THREE_DECIMAL_CURRENCIES.has(code)) {
    return Math.round(amount * 1000)
  }
  return Math.round(amount * 100)
}

/** Converts a Stripe minor-unit amount back to a major-unit amount. */
export function fromStripeMinorUnits(amount: number, currency: string) {
  const code = currency.toUpperCase()
  if (ZERO_DECIMAL_CURRENCIES.has(code)) {
    return amount
  }
  if (THREE_DECIMAL_CURRENCIES.has(code)) {
    return Math.round(amount) / 1000
  }
  return Math.round(amount) / 100
}
