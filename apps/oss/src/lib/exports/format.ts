import { Prisma } from "../../../generated/prisma/client"

export type DecimalLike = Prisma.Decimal | number | string

export function toDecimal(value: DecimalLike): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

/** Fixed two-decimal amount with half-up rounding and no negative zero, e.g. "1234.50". */
export function formatAmount(value: DecimalLike): string {
  const rounded = toDecimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
  return rounded.isZero() ? "0.00" : rounded.toFixed(2)
}

/** Smallest exact representation of a quantity or rate, e.g. "2", "1.5", "12.5". */
export function formatPlainNumber(value: DecimalLike): string {
  const decimal = toDecimal(value)
  return decimal.isZero() ? "0" : decimal.toFixed()
}

function safeTimeZone(timeZone: string | null | undefined) {
  if (!timeZone) return "UTC"
  try {
    new Intl.DateTimeFormat("en-US", { timeZone })
    return timeZone
  } catch {
    return "UTC"
  }
}

/** The calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function formatIsoDate(date: Date, timeZone?: string | null): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? ""
  return `${part("year")}-${part("month")}-${part("day")}`
}

/** Offset of a time zone from UTC at an instant, in milliseconds. */
function timeZoneOffset(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant))
  const value = (type: string) => Number(parts.find((entry) => entry.type === type)?.value ?? 0)
  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second")
  )
  return asUtc - Math.floor(instant / 1000) * 1000
}

/** The instant a calendar date (YYYY-MM-DD) starts in a time zone. */
export function startOfDayInTimeZone(isoDate: string, timeZone?: string | null): Date {
  const zone = safeTimeZone(timeZone)
  const [year, month, day] = isoDate.split("-").map(Number)
  const utcMidnight = Date.UTC(year!, month! - 1, day!)
  let instant = utcMidnight - timeZoneOffset(utcMidnight, zone)
  // A DST change between the guess and the result shifts the offset; correct once.
  instant = utcMidnight - timeZoneOffset(instant, zone)
  return new Date(instant)
}

/** Half-open [start, end) instants covering the inclusive calendar range in a time zone. */
export function dateRangeInTimeZone(from: string, to: string, timeZone?: string | null) {
  const [year, month, day] = to.split("-").map(Number)
  const next = new Date(Date.UTC(year!, month! - 1, day! + 1)).toISOString().slice(0, 10)
  return { start: startOfDayInTimeZone(from, timeZone), end: startOfDayInTimeZone(next, timeZone) }
}

/** A file name safe on every platform, keeping letters, digits, dot, dash and underscore. */
export function safeFileName(value: string, fallback = "document"): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
  return cleaned.length > 0 ? cleaned.slice(0, 100) : fallback
}
