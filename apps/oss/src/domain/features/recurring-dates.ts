/**
 * Pure date math for recurring invoice schedules.
 *
 * Run dates are calendar dates stored as UTC midnight, so every calculation here uses UTC
 * fields and never depends on the server's or organization's timezone.
 */

export type IntervalUnit = "week" | "month" | "year"

const DAY_MS = 24 * 60 * 60 * 1000

function daysInMonth(year: number, monthIndex: number) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

/** Parses `YYYY-MM-DD` as UTC midnight. */
export function parseCalendarDate(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
}

/** Formats a date as `YYYY-MM-DD` using its UTC calendar day. */
export function formatCalendarDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Truncates to UTC midnight of the same UTC calendar day. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export function addUtcDays(date: Date, days: number): Date {
  return new Date(startOfUtcDay(date).getTime() + days * DAY_MS)
}

/** The day of month a schedule bills on, taken from its start date. */
export function anchorDayOf(startDate: Date): number {
  return startDate.getUTCDate()
}

/**
 * Returns the run date that follows `date`.
 *
 * Monthly and yearly cadences keep the anchor day of month and clamp it to the last day of
 * shorter months, so an anchor of 31 runs Jan 31, Feb 28 (29 in leap years), Mar 31. Weekly
 * cadences ignore the anchor and add whole weeks.
 */
export function advanceRunDate(
  date: Date,
  intervalCount: number,
  intervalUnit: IntervalUnit,
  anchorDay: number
): Date {
  if (!Number.isInteger(intervalCount) || intervalCount < 1) {
    throw new RangeError("intervalCount must be a positive integer")
  }

  if (intervalUnit === "week") {
    return addUtcDays(date, intervalCount * 7)
  }

  const months = intervalUnit === "year" ? intervalCount * 12 : intervalCount
  const targetMonthIndex = date.getUTCMonth() + months
  const year = date.getUTCFullYear() + Math.floor(targetMonthIndex / 12)
  const monthIndex = targetMonthIndex % 12
  const day = Math.min(anchorDay, daysInMonth(year, monthIndex))
  return new Date(Date.UTC(year, monthIndex, day))
}

export type Cadence = {
  startDate: Date
  intervalCount: number
  intervalUnit: IntervalUnit
}

/**
 * The first run date of the cadence that is on or after `threshold`'s calendar day and, when
 * given, strictly after `after`. Missed run dates in between are skipped, not back-billed.
 */
export function firstRunDateFrom(
  cadence: Cadence,
  threshold: Date,
  after: Date | null = null
): Date {
  const anchor = anchorDayOf(cadence.startDate)
  const floor = startOfUtcDay(threshold)
  let candidate = startOfUtcDay(cadence.startDate)

  // Bounded: 12 runs a year for a century of weekly cadence is still a short loop.
  for (let guard = 0; guard < 10_000; guard += 1) {
    if (candidate >= floor && (!after || candidate > after)) {
      return candidate
    }
    candidate = advanceRunDate(candidate, cadence.intervalCount, cadence.intervalUnit, anchor)
  }
  throw new RangeError("Could not find the next run date")
}
