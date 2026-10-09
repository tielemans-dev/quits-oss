import { normalizeLocale, normalizeTimeZone } from "../../lib/i18n/locale"
import { resolveLanguage } from "../../lib/i18n/translate"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * "just now", "3 hours ago", "yesterday", and from a week on a short date ("8. okt."). Measured
 * from `now`, which is the summary's own `asOf`, so the feed and the figures agree on the moment.
 */
export function formatRelativeTime(
  iso: string,
  now: string,
  locale: string | null | undefined,
  timeZone: string | null | undefined
): string {
  const resolved = normalizeLocale(locale)
  const zone = normalizeTimeZone(timeZone)
  const elapsed = Math.max(0, Date.parse(now) - Date.parse(iso))
  const relative = new Intl.RelativeTimeFormat(resolved, { numeric: "auto" })
  if (elapsed < MINUTE) return relative.format(0, "second")
  if (elapsed < HOUR) return relative.format(-Math.floor(elapsed / MINUTE), "minute")
  if (elapsed < DAY) return relative.format(-Math.floor(elapsed / HOUR), "hour")
  if (elapsed < 7 * DAY) return relative.format(-Math.floor(elapsed / DAY), "day")
  return new Intl.DateTimeFormat(resolved, { day: "numeric", month: "short", timeZone: zone }).format(
    new Date(iso)
  )
}

/**
 * The day the summary was taken, in the organization's time zone, as a heading line: "Torsdag 8.
 * oktober" or "Thursday 8 October". Built from the parts of the date rather than a locale pattern,
 * so it reads the same in every ICU version ("torsdag den 8. oktober" in some).
 */
export function formatLongDate(
  iso: string,
  locale: string | null | undefined,
  timeZone: string | null | undefined
): string {
  const danish = resolveLanguage(locale) === "da"
  const parts = new Intl.DateTimeFormat(danish ? "da-DK" : "en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: normalizeTimeZone(timeZone),
  }).formatToParts(new Date(iso))
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? ""
  const weekday = part("weekday")
  const text = danish
    ? `${weekday} ${part("day")}. ${part("month")}`
    : `${weekday} ${part("day")} ${part("month")}`
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** A calendar date (YYYY-MM-DD) as "12. okt." / "12 Oct": a date without a time has no zone to move it. */
export function formatShortDate(isoDate: string, locale: string | null | undefined): string {
  return new Intl.DateTimeFormat(normalizeLocale(locale), {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`))
}

/** "oktober", for the month the summary was taken in. */
export function formatMonthName(
  iso: string,
  locale: string | null | undefined,
  timeZone: string | null | undefined
): string {
  return new Intl.DateTimeFormat(normalizeLocale(locale), {
    month: "long",
    timeZone: normalizeTimeZone(timeZone),
  }).format(new Date(iso))
}

/** A chart month, from "2026-10": the short name ("okt.") or the long one with the year. */
export function formatChartMonth(
  month: string,
  style: "short" | "long",
  locale: string | null | undefined
): string {
  const [year, number] = month.split("-").map(Number)
  const date = new Date(Date.UTC(year!, number! - 1, 1))
  return new Intl.DateTimeFormat(normalizeLocale(locale), {
    month: style,
    ...(style === "long" ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(date)
}
