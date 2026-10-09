import { afterEach, describe, expect, it } from "vitest"

import {
  attentionAction,
  classifyDashboard,
  dueLabel,
  localToday,
  incomingRule,
  isLate,
  presentChart,
  presentHero,
  streakVisible,
  toMinor,
} from "../summary-model"
import { formatShortDate } from "../format-relative"
import { reminderFailure } from "../use-reminders"
import { activeSummary, bucket, emptySummary, emptyTotal, money, MONTHS, storageBucket, total, unvaluedOnly } from "./fixtures"

describe("classifyDashboard", () => {
  it("is first-run when nothing exists, so there is nothing to total", () => {
    expect(classifyDashboard(emptySummary())).toBe("first-run")
  })

  it("is getting-started when drafts or events exist but no money has moved", () => {
    const attention = activeSummary().attention.slice(1)
    expect(classifyDashboard(emptySummary({ attention }))).toBe("getting-started")
    expect(classifyDashboard(emptySummary({ activity: activeSummary().activity }))).toBe("getting-started")
  })

  it("is getting-started when only drafts exist", () => {
    expect(classifyDashboard(emptySummary({ drafts: { count: 1, newestId: "d", newestKind: "invoice" } }))).toBe("getting-started")
  })

  it("is active while money is owed, and kvit once money has moved and none is owed", () => {
    expect(classifyDashboard(activeSummary())).toBe("active")
    const settled = activeSummary({ outstanding: emptyTotal(), overdue: { ...emptyTotal(), oldestDaysOverdue: 0 }, incoming: [] })
    expect(classifyDashboard(settled)).toBe("kvit")
  })

  it("counts money received any month of the year as having moved", () => {
    const history = emptySummary({
      receivedByMonth: MONTHS.map((month, index) => ({ month, ...(index === 2 ? total(bucket("DKK", "100.00")) : emptyTotal()) })),
    })
    expect(classifyDashboard(history)).toBe("kvit")
  })
})

describe("presentHero money", () => {
  it("shows the base currency as the figure and never adds another currency to it", () => {
    const hero = presentHero(activeSummary())
    expect(hero.currency).toBe("DKK")
    expect(hero.outstanding?.amount).toBe("20000.00")
    expect(hero.outstanding?.count).toBe(3)
    // 20000 DKK + 1800 EUR would be 21800 of nothing: it must not exist anywhere.
    expect(JSON.stringify(hero)).not.toContain("21800")
  })

  it("lists every other currency as a secondary line of its own", () => {
    const hero = presentHero(activeSummary())
    expect(hero.others).toEqual([{ currency: "EUR", outstanding: bucket("EUR", "1800.00"), overdue: null }])
  })

  it("keeps a non-base overdue amount with its own currency line", () => {
    const summary = activeSummary({
      overdue: { ...total(bucket("DKK", "8750.00", 1, 14), bucket("EUR", "300.00", 1, 40)), oldestDaysOverdue: 40 },
    })
    const hero = presentHero(summary)
    expect(hero.others[0]?.overdue?.amount).toBe("300.00")
    expect(hero.overdue?.bucket.amount).toBe("8750.00")
  })

  it("reads the oldest age from the hero currency's own bucket, even with other currencies overdue", () => {
    const summary = activeSummary({
      overdue: { ...total(bucket("DKK", "8750.00", 1, 14), bucket("EUR", "300.00", 1, 40)), oldestDaysOverdue: 40 },
    })
    // 40 belongs to the EUR invoice; the DKK figure must say 14.
    expect(presentHero(summary).overdue?.oldestDaysOverdue).toBe(14)
  })

  it("never adds the unvalued overlap: a currency in both buckets and unvalued counts once", () => {
    const summary = activeSummary()
    summary.outstanding.unvalued = [bucket("DKK", "20000.00", 3), bucket("EUR", "1800.00")]
    summary.overdue.unvalued = [bucket("DKK", "8750.00")]
    const hero = presentHero(summary)
    expect(hero.outstanding?.amount).toBe("20000.00")
    expect(hero.others.map((other) => other.currency)).toEqual(["EUR"])
    expect(hero.segments).toEqual(presentHero(activeSummary()).segments)
  })

  it("shows a currency that is only in unvalued once, as a secondary line, and adds it to nothing", () => {
    const summary = activeSummary()
    summary.outstanding = {
      count: 5,
      buckets: summary.outstanding.buckets,
      unvalued: [bucket("DKK", "20000.00", 3), storageBucket("ZZZ", "75.50")],
    }
    const hero = presentHero(summary)
    expect(hero.currency).toBe("DKK")
    expect(hero.outstanding?.amount).toBe("20000.00")
    expect(hero.others.map((other) => [other.currency, other.outstanding.amount])).toEqual([
      ["EUR", "1800.00"],
      ["ZZZ", "75.50"],
    ])
    expect(JSON.stringify(hero)).not.toContain("20075.50")
    expect(hero.segments).toEqual(presentHero(activeSummary()).segments)
  })

  it("never makes a sole unvalued currency the headline: the base currency stays, empty, with the line beneath", () => {
    const summary = activeSummary({
      outstanding: unvaluedOnly(bucket("BHD", "12345.678")),
      overdue: { ...unvaluedOnly(bucket("BHD", "100.000", 1, 4)), oldestDaysOverdue: 4 },
      paidThisMonth: emptyTotal(),
    })
    const hero = presentHero(summary)
    expect(hero.currency).toBe("DKK")
    expect(hero.outstanding).toBeNull()
    expect(hero.overdue).toBeNull()
    expect(hero.paid).toBeNull()
    expect(hero.segments).toBeNull()
    expect(hero.noneOverdue).toBe(false)
    expect(hero.others.map((other) => [other.currency, other.outstanding.amount, other.overdue?.amount])).toEqual([
      ["BHD", "12345.678", "100.000"],
    ])
  })

  it("does not let unvalued receipts feed the split or the chart, even in the base currency", () => {
    const summary = activeSummary({
      outstanding: total(bucket("DKK", "1000.00", 1)),
      overdue: { ...emptyTotal(), oldestDaysOverdue: 0 },
      paidThisMonth: unvaluedOnly(bucket("DKK", "500.00", 2)),
      receivedByMonth: MONTHS.map((month, index) => ({
        month,
        ...(index === 11 ? unvaluedOnly(bucket("DKK", "500.00", 2)) : emptyTotal()),
      })),
    })
    const hero = presentHero(summary)
    expect(hero.paid).toBeNull()
    expect(hero.segments).toEqual({ paid: 0, pending: 1, overdue: 0 })
    const chart = presentChart(summary)
    expect(chart.hasData).toBe(false)
    expect(chart.total).toBe("0.00")
    expect(chart.months[11]).toMatchObject({ amount: null, value: 0 })
  })

  it("uses the valued bucket when the same currency is in unvalued as well", () => {
    const summary = activeSummary()
    summary.paidThisMonth.unvalued = [bucket("DKK", "10000.00", 2)]
    summary.receivedByMonth[11]!.unvalued = [bucket("DKK", "10000.00", 2)]
    const hero = presentHero(summary)
    expect(hero.paid?.amount).toBe("10000.00")
    expect(hero.others.map((other) => other.currency)).toEqual(["EUR"])
    expect(presentChart(summary).total).toBe("10000.00")
  })

  it("states the precision of what it shows", () => {
    expect(presentHero(activeSummary()).precision).toEqual({ exponent: 2 })
    const storage = presentHero(activeSummary({ outstanding: total(storageBucket("ZZZ", "75.50")), overdue: { ...emptyTotal(), oldestDaysOverdue: 0 } }))
    expect(storage.currency).toBe("ZZZ")
    expect(storage.precision).toEqual({ exponent: 2, source: "storage" })
    // Nothing valued: the base currency's own table exponent.
    expect(presentHero(emptySummary({ baseCurrency: "JPY" })).precision).toEqual({ exponent: 0 })
  })

  it("reads three decimals exactly", () => {
    expect(toMinor({ amount: "12345.678", exponent: 3 })).toBe(12345678n)
    expect(toMinor({ amount: "0.005", exponent: 3 })).toBe(5n)
  })

  it("falls back to the owed currency when nothing is owed in the base currency", () => {
    const summary = activeSummary({
      outstanding: total(bucket("EUR", "1800.00")),
      overdue: { ...emptyTotal(), oldestDaysOverdue: 0 },
      paidThisMonth: emptyTotal(),
    })
    const hero = presentHero(summary)
    expect(hero.currency).toBe("EUR")
    expect(hero.outstanding?.amount).toBe("1800.00")
    expect(hero.others).toEqual([])
  })

  it("splits the month into paid, on its way and overdue, with overdue taken out of outstanding", () => {
    const hero = presentHero(activeSummary())
    // Paid 10000, on its way 20000 - 8750, overdue 8750: a total of 30000.
    expect(hero.segments?.paid).toBeCloseTo(10000 / 30000)
    expect(hero.segments?.pending).toBeCloseTo(11250 / 30000)
    expect(hero.segments?.overdue).toBeCloseTo(8750 / 30000)
    const shares = hero.segments!
    expect(shares.paid + shares.pending + shares.overdue).toBeCloseTo(1)
  })

  it("has no split when all three are zero", () => {
    expect(presentHero(emptySummary()).segments).toBeNull()
  })

  it("has no age when the bucket carries none", () => {
    const summary = activeSummary({ overdue: { ...total(bucket("DKK", "8750.00")), oldestDaysOverdue: 14 } })
    expect(presentHero(summary).overdue?.oldestDaysOverdue).toBeNull()
  })
})

describe("presentChart", () => {
  it("draws the base currency only and passes on the summary's other-currency flag", () => {
    const chart = presentChart(activeSummary())
    expect(chart.currency).toBe("DKK")
    expect(chart.months).toHaveLength(12)
    expect(chart.months[11]).toMatchObject({ amount: "10000.00", isCurrent: true })
    // The EUR month is not drawn as DKK.
    expect(chart.months[5]).toMatchObject({ amount: null, value: 0 })
    expect(chart.hasOtherCurrencies).toBe(true)
    expect(presentChart({ ...activeSummary(), hasOtherCurrencies: false }).hasOtherCurrencies).toBe(false)
    expect(chart.total).toBe("10000.00")
  })

  it("adds the months of one currency exactly", () => {
    const summary = emptySummary({
      receivedByMonth: MONTHS.map((month, index) => ({ month, ...(index < 3 ? total(bucket("DKK", "0.10")) : emptyTotal()) })),
    })
    expect(presentChart(summary).total).toBe("0.30")
  })

  it("has no data, and no other-currency note, for an empty year", () => {
    const chart = presentChart(emptySummary())
    expect(chart.hasData).toBe(false)
    expect(chart.hasOtherCurrencies).toBe(false)
  })
})

describe("toMinor", () => {
  it("reads exact decimals without floats", () => {
    expect(toMinor({ amount: "12.50", exponent: 2 })).toBe(1250n)
    expect(toMinor({ amount: "7", exponent: 0 })).toBe(7n)
    expect(toMinor({ amount: "9999999999.99", exponent: 2 })).toBe(999999999999n)
  })
})

describe("streak", () => {
  it("is quiet below two", () => {
    expect([0, 1].map(streakVisible)).toEqual([false, false])
    expect([2, 12].map(streakVisible)).toEqual([true, true])
  })
})

describe("due dates", () => {
  const today = "2026-10-08"
  it("reads the day in the organization's time zone", () => {
    // 23:30 UTC is already the next day in Copenhagen.
    expect(localToday("2026-10-08T23:30:00.000Z", "Europe/Copenhagen")).toBe("2026-10-09")
    expect(localToday("2026-10-08T23:30:00.000Z", "UTC")).toBe("2026-10-08")
  })

  it("labels late, today, tomorrow and later", () => {
    const at = (dueDate: string, daysOverdue: number, isOverdue: boolean) => dueLabel({ dueDate, daysOverdue, isOverdue }, today)
    expect(at("2026-09-24", 14, true)).toEqual({ kind: "overdue", days: 14 })
    expect(at("2026-10-08", 0, false)).toEqual({ kind: "today" })
    expect(at("2026-10-09", 0, false)).toEqual({ kind: "tomorrow" })
    expect(at("2026-10-18", 0, false)).toEqual({ kind: "later", days: 10 })
  })

  it("never says zero days overdue: a zero-day arrear is due today", () => {
    expect(dueLabel({ dueDate: "2026-10-08", daysOverdue: 0, isOverdue: true }, today)).toEqual({ kind: "today" })
    expect(dueLabel({ dueDate: "2026-10-08", daysOverdue: 1, isOverdue: true }, today)).toEqual({ kind: "overdue", days: 1 })
  })

  it("is late only for a real arrear", () => {
    expect([
      isLate({ isOverdue: true, daysOverdue: 3 }),
      isLate({ isOverdue: true, daysOverdue: 0 }),
      isLate({ isOverdue: true, daysOverdue: null }),
      isLate({ isOverdue: false, daysOverdue: 5 }),
    ]).toEqual([true, false, false, false])
  })
})

describe("incomingRule", () => {
  const rule = (balance: string, totalAmount: string) => incomingRule({ amount: money("DKK", balance), total: money("DKK", totalAmount) })

  it("is a single rule while nothing is settled", () => {
    expect(rule("1000.00", "1000.00")).toEqual({ rule: "single" })
  })

  it("draws the second rule as far as it is paid or credited: 1 - balance/total", () => {
    expect(rule("6000.00", "18000.00")).toEqual({ rule: "double", paidFraction: 12000 / 18000 })
    expect(rule("250.00", "1000.00")).toEqual({ rule: "double", paidFraction: 0.75 })
  })

  it("never draws past the total, and treats a balance above it as nothing settled", () => {
    expect(rule("1200.00", "1000.00")).toEqual({ rule: "single" })
  })

  it("is exact on small cents", () => {
    expect(rule("0.10", "0.30")).toEqual({ rule: "double", paidFraction: 20 / 30 })
  })
})

describe("attention", () => {
  const [overdue, draft] = activeSummary().attention

  it("offers a reminder only where the server says one can be sent", () => {
    expect(attentionAction(overdue!)).toBe("remind")
    expect(attentionAction({ ...overdue!, canRemind: false })).toBe("open")
    expect(attentionAction(draft!)).toBe("open")
    expect(attentionAction({ ...draft!, canRemind: true })).toBe("open")
  })

  it("keeps money exact in documents", () => {
    expect(overdue!.amount).toEqual(money("DKK", "8750.00"))
  })
})

describe("reminderFailure", () => {
  it("reads a domain refusal by its reason and any other error by its code", () => {
    expect(reminderFailure({ data: { reason: "already_reminded", code: "BAD_REQUEST" } })).toBe("alreadyReminded")
    expect(reminderFailure({ data: { reason: "missing_recipient" } })).toBe("noRecipient")
    expect(reminderFailure({ data: { reason: "email_provider_refused", code: "PRECONDITION_FAILED" } })).toBe("emailProviderRefused")
    expect(reminderFailure({ data: { reason: "email_provider_unreachable" } })).toBe("emailProviderUnreachable")
    expect(reminderFailure({ data: { code: "FORBIDDEN" } })).toBe("forbidden")
    expect(reminderFailure({ data: { code: "NOT_FOUND" } })).toBe("notFound")
  })

  it("never keys on message text", () => {
    expect(reminderFailure(new Error("A reminder for this invoice was already sent today"))).toBe("unknown")
    expect(reminderFailure({ data: { reason: "something_new", code: "INTERNAL_SERVER_ERROR" } })).toBe("unknown")
    expect(reminderFailure(null)).toBe("unknown")
    expect(reminderFailure("boom")).toBe("unknown")
  })
})

describe("calendar dates", () => {
  const original = process.env.TZ
  afterEach(() => {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  })

  it.each(["America/New_York", "Pacific/Auckland", "UTC"])(
    "never shifts a stored calendar day in %s",
    (zone) => {
      process.env.TZ = zone
      expect(formatShortDate("2026-10-12", "da-DK")).toBe("12. okt.")
      expect(formatShortDate("2026-10-12", "en-GB")).toBe("12 Oct")
      expect(formatShortDate("2026-01-01", "da-DK")).toBe("1. jan.")
      expect(dueLabel({ dueDate: "2026-10-09", daysOverdue: 0, isOverdue: false }, "2026-10-08")).toEqual({ kind: "tomorrow" })
      expect(dueLabel({ dueDate: "2026-10-18", daysOverdue: 0, isOverdue: false }, "2026-10-08")).toEqual({ kind: "later", days: 10 })
    }
  )
})
