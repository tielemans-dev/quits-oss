import { getCurrencyExponent } from "@quits/shared/currency"

import { normalizeCurrency, normalizeLocale } from "../../lib/i18n/locale"

/**
 * A money value for `Amount`: a decimal string ("5600.00", "-12.5") or integer minor units
 * ({ minor: 560000 } is 5.600,00 in a two-decimal currency). Both reach Intl as a decimal string,
 * so no float arithmetic touches a price.
 */
export type AmountValue = string | { minor: number | bigint }

/** One piece of a formatted amount, in the order the locale prints them. */
export type AmountPart = {
  type: "integer" | "fraction" | "decimal" | "other"
  value: string
}

const DECIMAL_PATTERN = /^[+-]?\d+(\.\d+)?$/

function exponentFor(currency: string): number {
  return getCurrencyExponent(currency) ?? 2
}

/**
 * Minor units as a decimal string, by moving the point in the digits: no division. `-5` with
 * exponent 2 is "-0.05".
 */
export function minorToDecimal(minor: number | bigint, exponent: number): string {
  if (typeof minor === "number" && !Number.isSafeInteger(minor)) {
    throw new RangeError("Amount minor units must be a safe integer")
  }
  const big = BigInt(minor)
  const negative = big < 0n
  const digits = (negative ? -big : big).toString().padStart(exponent + 1, "0")
  const whole = digits.slice(0, digits.length - exponent)
  const fraction = digits.slice(digits.length - exponent)
  return `${negative ? "-" : ""}${whole}${exponent > 0 ? `.${fraction}` : ""}`
}

/** The largest amount of the API's `Decimal(12,2)` columns. */
const MAX_NUMBER_AMOUNT = 9_999_999_999.99

/** Shown where an amount cannot be formatted. */
export const AMOUNT_UNAVAILABLE = "—"

/**
 * A money amount that the API serialises as a JS number in major units ("5600" or "1234.5") as a
 * decimal string at the currency's precision. The API converts from an exact Decimal, so the number
 * already has at most `exponent` decimals; this only writes it down.
 *
 * Supported: values up to `Decimal(12,2)`, 9,999,999,999.99, which a double holds exactly to the
 * cent. Anything bigger must be passed to `Amount` as a decimal string. A number outside that
 * range, or not finite (NaN, Infinity), returns null instead of a wrong or thrown amount, and
 * `Amount` shows an em dash for null. A rounded negative zero is written as zero: -0.001 is
 * "0.00", never "-0.00".
 */
export function decimalFromNumber(value: number, currency: string): string | null {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_NUMBER_AMOUNT) return null
  const fixed = value.toFixed(exponentFor(normalizeCurrency(currency)))
  return /^-0(\.0+)?$/.test(fixed) ? fixed.slice(1) : fixed
}

/**
 * The precision a source states for an amount. `exponent` is how many decimals it has; the formatter
 * writes exactly that many, whatever Intl believes the currency uses. `source: "storage"` marks an
 * unknown currency whose two decimals are the database's scale, not an ISO exponent: it is written
 * with two decimals and the ISO code, never a symbol and never rounded to the currency's usual unit
 * (an unknown "CLP" amount of 75.50 is "75,50 CLP", not "76 CLP").
 */
export type AmountPrecision = { exponent: number; source?: "storage" }

function toDecimalString(value: AmountValue, currency: string, precision?: AmountPrecision): string {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!DECIMAL_PATTERN.test(trimmed)) throw new RangeError(`Not a decimal amount: ${value}`)
    return trimmed
  }
  return minorToDecimal(value.minor, precision?.exponent ?? exponentFor(currency))
}

type DecimalFormatter = { formatToParts: (value: string) => Intl.NumberFormatPart[] }

/**
 * Splits a formatted amount into parts so the fraction can be set raised and small. Intl accepts a
 * decimal string and formats it exactly; an engine that does not reads it as a number, which is
 * equally exact for two decimals.
 */
export function formatAmountParts(
  value: AmountValue,
  currency: string | null | undefined,
  locale: string | null | undefined,
  precision?: AmountPrecision
): AmountPart[] {
  const code = normalizeCurrency(currency)
  const formatter = new Intl.NumberFormat(normalizeLocale(locale), {
    style: "currency",
    currency: code,
    ...(precision
      ? {
          minimumFractionDigits: precision.exponent,
          maximumFractionDigits: precision.exponent,
          ...(precision.source === "storage" ? { currencyDisplay: "code" as const } : {}),
        }
      : {}),
  }) as unknown as DecimalFormatter

  return formatter.formatToParts(toDecimalString(value, code, precision)).map((part) => {
    if (part.type === "integer" || part.type === "fraction" || part.type === "decimal") {
      return { type: part.type, value: part.value }
    }
    return { type: "other", value: part.value }
  })
}

/** The plain text of the same amount ("5.600,00 kr."), for tooltips and the cases that need a string. */
export function formatAmountText(
  value: AmountValue | null,
  currency: string | null | undefined,
  locale: string | null | undefined,
  precision?: AmountPrecision
): string {
  if (value === null) return AMOUNT_UNAVAILABLE
  return formatAmountParts(value, currency, locale, precision)
    .map((part) => part.value)
    .join("")
}
