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
  }
): string {
  return new Intl.DateTimeFormat(normalizeLocale(locale), {
    year: "numeric",
    month: options?.month ?? "long",
    day: "numeric",
    timeZone: normalizeTimeZone(timeZone),
  }).format(new Date(date))
}
