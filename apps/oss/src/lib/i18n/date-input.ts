import { normalizeLocale } from "./locale"

function parseIsoDateParts(isoDate: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim())
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null
  }

  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null
  }

  return { year, month, day }
}

export function formatIsoDateForInputDisplay(isoDate: string, locale?: string | null) {
  const parsed = parseIsoDateParts(isoDate)
  if (!parsed) return isoDate

  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day))
  return new Intl.DateTimeFormat(normalizeLocale(locale), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(date)
}

/** The order a locale writes day, month and year in, e.g. day, month, year for Danish. */
function localeDateOrder(locale?: string | null) {
  return new Intl.DateTimeFormat(normalizeLocale(locale), { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })
    .formatToParts(new Date(Date.UTC(2026, 0, 2)))
    .flatMap(part => part.type === "day" || part.type === "month" || part.type === "year" ? [part.type] : [])
}

/**
 * A typed date as an ISO date, or null when it is not one. Read in the locale's order with any of
 * `.`, `/`, `-` or a space between the parts, so "20.10.2026" and "20/10/26" are 20 October in Danish.
 * A pasted ISO date is also accepted.
 */
export function parseLocalizedDateInput(text: string, locale?: string | null): string | null {
  const value = text.trim().replace(/[./\-\s]+$/, "")
  const isIso = /^\d{4}-\d{1,2}-\d{1,2}$/.test(value)
  const numbers = value.split(/[./\-\s]+/)
  if (numbers.length !== 3 || numbers.some(part => !/^\d{1,4}$/.test(part))) return null
  const order = isIso ? ["year", "month", "day"] : localeDateOrder(locale)
  const part = (type: string) => numbers[order.indexOf(type)] ?? ""
  const year = part("year").length === 2 ? `20${part("year")}` : part("year")
  if (year.length !== 4 || part("month").length > 2 || part("day").length > 2) return null
  const iso = `${year}-${part("month").padStart(2, "0")}-${part("day").padStart(2, "0")}`
  return parseIsoDateParts(iso) ? iso : null
}
