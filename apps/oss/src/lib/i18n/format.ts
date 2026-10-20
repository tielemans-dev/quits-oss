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
    /** Compact Gregorian invoice dates use day-month-year in Danish and English. */
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
  const language = new Intl.Locale(normalizeLocale(locale)).language
  // Other locales/calendars need Intl's era, related year and native date notation.
  if (!options?.dayFirst || formatter.resolvedOptions().calendar !== "gregory" || (language !== "da" && language !== "en")) {
    return formatter.format(value)
  }
  const parts = formatter.formatToParts(value)
  if (parts.some(piece => piece.type !== "day" && piece.type !== "month" && piece.type !== "year" && piece.type !== "literal")) {
    return formatter.format(value)
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(piece => piece.type === type)?.value ?? ""
  const daySuffix = language === "da" ? "." : ""
  return `${part("day")}${daySuffix} ${part("month")} ${part("year")}`
}

/** Compact document dates, with day before month in both supported languages. */
export function formatShortDate(date: Date | string, locale?: string | null, timeZone?: string | null): string {
  const configuredLocale = normalizeLocale(locale)
  const language = configuredLocale.toLowerCase().startsWith("en") ? "en-GB" : configuredLocale
  return formatDate(date, language, timeZone, { month: "short" })
}

/** A moment, such as an acceptance, with date and time in the given time zone. */
export function formatDateTime(date: Date | string, locale?: string | null, timeZone?: string | null): string {
  return new Intl.DateTimeFormat(normalizeLocale(locale), {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: normalizeTimeZone(timeZone),
  }).format(new Date(date))
}
