import { describe, expect, it } from "vitest"
import {
  advanceRunDate,
  firstRunDateFrom,
  formatCalendarDate,
  parseCalendarDate,
  type IntervalUnit,
} from "../features/recurring-dates"

function series(start: string, count: number, unit: IntervalUnit, runs: number) {
  const startDate = parseCalendarDate(start)
  const anchor = startDate.getUTCDate()
  const dates = [startDate]
  for (let index = 1; index < runs; index += 1) {
    dates.push(advanceRunDate(dates[index - 1], count, unit, anchor))
  }
  return dates.map(formatCalendarDate)
}

describe("advanceRunDate", () => {
  it("keeps the anchor day and clamps to the end of shorter months", () => {
    expect(series("2026-01-31", 1, "month", 5)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
    ])
  })

  it("uses February 29 in leap years", () => {
    expect(series("2027-12-31", 2, "month", 3)).toEqual(["2027-12-31", "2028-02-29", "2028-04-30"])
  })

  it("crosses year boundaries for multi-month intervals", () => {
    expect(series("2026-11-15", 3, "month", 3)).toEqual(["2026-11-15", "2027-02-15", "2027-05-15"])
    expect(series("2026-01-30", 12, "month", 2)).toEqual(["2026-01-30", "2027-01-30"])
  })

  it("adds whole weeks and ignores the anchor day", () => {
    expect(series("2026-12-24", 2, "week", 3)).toEqual(["2026-12-24", "2027-01-07", "2027-01-21"])
  })

  it("advances yearly cadences and clamps a February 29 anchor", () => {
    expect(series("2028-02-29", 1, "year", 5)).toEqual([
      "2028-02-29",
      "2029-02-28",
      "2030-02-28",
      "2031-02-28",
      "2032-02-29",
    ])
  })

  it("ignores the time of day and timezone of the input", () => {
    const lateEvening = new Date("2026-01-31T23:30:00.000Z")
    expect(advanceRunDate(lateEvening, 1, "month", 31).toISOString()).toBe("2026-02-28T00:00:00.000Z")
  })

  it("rejects non-positive intervals", () => {
    expect(() => advanceRunDate(parseCalendarDate("2026-01-01"), 0, "month", 1)).toThrow(RangeError)
  })
})

describe("firstRunDateFrom", () => {
  const cadence = {
    startDate: parseCalendarDate("2026-01-31"),
    intervalCount: 1,
    intervalUnit: "month" as const,
  }

  it("returns the start date when it is in the future", () => {
    expect(formatCalendarDate(firstRunDateFrom(cadence, parseCalendarDate("2026-01-10")))).toBe(
      "2026-01-31"
    )
  })

  it("includes a run that falls on the threshold day", () => {
    expect(
      formatCalendarDate(firstRunDateFrom(cadence, new Date("2026-02-28T18:00:00.000Z")))
    ).toBe("2026-02-28")
  })

  it("skips missed runs and runs already generated", () => {
    const today = parseCalendarDate("2026-04-02")
    expect(formatCalendarDate(firstRunDateFrom(cadence, today))).toBe("2026-04-30")
    expect(
      formatCalendarDate(
        firstRunDateFrom(cadence, parseCalendarDate("2026-03-01"), parseCalendarDate("2026-03-31"))
      )
    ).toBe("2026-04-30")
  })
})
