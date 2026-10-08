import { Effect } from "effect"
import { formatIsoDate, startOfDayInTimeZone } from "../../lib/exports/format"
import { ValidationFailed } from "../errors"
import { Command, Db } from "../services"
const FUTURE_DATE_TOLERANCE_MS = 14 * 60 * 60 * 1000
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/

const futurePaymentDate = () =>
  new ValidationFailed({
    message: "The payment date cannot be in the future",
    issues: [{ path: "paidAt", message: "The payment date cannot be in the future" }],
  })

/**
 * A calendar date (`YYYY-MM-DD`) is the day the money arrived in the organization's time zone,
 * so it is stored as the instant that day starts there. Accounting exports group payments by the
 * same time zone, which keeps an October 1 payment in October. Full timestamps are kept as is.
 */
export const parsePaidAt = (value: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId, now } = yield* Command
    if (CALENDAR_DATE.test(value)) {
      const settings = yield* Effect.promise(() =>
        db.orgSettings.findUnique({ where: { organizationId }, select: { timezone: true } })
      )
      const timeZone = settings?.timezone ?? "UTC"
      if (value > formatIsoDate(now, timeZone)) {
        return yield* futurePaymentDate()
      }
      return startOfDayInTimeZone(value, timeZone)
    }

    const paidAt = new Date(value)
    if (paidAt.getTime() > now.getTime() + FUTURE_DATE_TOLERANCE_MS) {
      return yield* futurePaymentDate()
    }
    return paidAt
  })
