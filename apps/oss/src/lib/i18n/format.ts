import {
  normalizeCurrency,
  normalizeLocale,
  normalizeTimeZone,
} from "./locale"

export function formatCurrency(
  amount: number,
  currency?: string | null,
  locale?: string | null
): string {
  return new Intl.NumberFormat(normalizeLocale(locale), {
    style: "currency",
    currency: normalizeCurrency(currency),
  }).format(amount)
}

/** A plain number such as a quantity, with the locale's decimal separator and no currency. */
export function formatNumber(value: number, locale?: string | null): string {
  return new Intl.NumberFormat(normalizeLocale(locale), {
    maximumFractionDigits: 4,
  }).format(value)
}

export function formatDate(
  date: Date | string,
  locale?: string | null,
  timeZone?: string | null,
  options?: {
    month?: "numeric" | "2-digit" | "long" | "short" | "narrow"
    /** Compact invoice dates use day-month-year even in en-US. */
    dayFirst?: boolean
  }
): string {
  const formatter = new Intl.DateTimeFormat(normalizeLocale(locale), {
    year: "numeric",
    month: options?.month ?? "short",
    day: "numeric",
    timeZone: normalizeTimeZone(timeZone),
  })
  const value = new Date(date)
  if (!options?.dayFirst) return formatter.format(value)
  const parts = formatter.formatToParts(value)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(piece => piece.type === type)?.value ?? ""
  const daySuffix = normalizeLocale(locale) === "da-DK" ? "." : ""
  return `${part("day")}${daySuffix} ${part("month")} ${part("year")}`
}

/** Compact document dates, with day before month in both supported languages. */
export function formatShortDate(date: Date | string, locale?: string | null, timeZone?: string | null): string {
  const configuredLocale = normalizeLocale(locale)
  const language = configuredLocale.toLowerCase().startsWith("en") ? "en-GB" : configuredLocale
  return formatDate(date, language, timeZone, { month: "short" })
}
