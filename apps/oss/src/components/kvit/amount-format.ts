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

/**
 * A money amount that the API serialises as a JS number in major units ("5600" or "1234.5") as a
 * decimal string at the currency's precision. The API converts from an exact Decimal, so the number
 * already has at most `exponent` decimals; this only writes it down.
 */
export function decimalFromNumber(value: number, currency: string): string {
  if (!Number.isFinite(value)) return "0"
  return value.toFixed(exponentFor(normalizeCurrency(currency)))
}

function toDecimalString(value: AmountValue, currency: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!DECIMAL_PATTERN.test(trimmed)) throw new RangeError(`Not a decimal amount: ${value}`)
    return trimmed
  }
  return minorToDecimal(value.minor, exponentFor(currency))
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
  locale: string | null | undefined
): AmountPart[] {
  const code = normalizeCurrency(currency)
  const formatter = new Intl.NumberFormat(normalizeLocale(locale), {
    style: "currency",
    currency: code,
  }) as unknown as DecimalFormatter

  return formatter.formatToParts(toDecimalString(value, code)).map((part) => {
    if (part.type === "integer" || part.type === "fraction" || part.type === "decimal") {
      return { type: part.type, value: part.value }
    }
    return { type: "other", value: part.value }
  })
}

/** The plain text of the same amount ("5.600,00 kr."), for tooltips and the cases that need a string. */
export function formatAmountText(
  value: AmountValue,
  currency: string | null | undefined,
  locale: string | null | undefined
): string {
  return formatAmountParts(value, currency, locale)
    .map((part) => part.value)
    .join("")
}
