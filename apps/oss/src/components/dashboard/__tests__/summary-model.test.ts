import { describe, expect, it } from "vitest"

import {
  attentionAction,
  classifyDashboard,
  dueLabel,
  localToday,
  overdueDaysFor,
  presentChart,
  presentHero,
  streakVisible,
  toMinor,
} from "../summary-model"
import { activeSummary, bucket, emptySummary, emptyTotal, money, MONTHS, total } from "./fixtures"

describe("classifyDashboard", () => {
  it("is first-run when nothing exists, so there is nothing to total", () => {
    expect(classifyDashboard(emptySummary())).toBe("first-run")
  })

  it("is getting-started when drafts or events exist but no money has moved", () => {
    const attention = activeSummary().attention.slice(1)
    expect(classifyDashboard(emptySummary({ attention }))).toBe("getting-started")
    expect(classifyDashboard(emptySummary({ activity: activeSummary().activity }))).toBe("getting-started")
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
      overdue: { ...total(bucket("DKK", "8750.00"), bucket("EUR", "300.00")), oldestDaysOverdue: 14 },
    })
    const hero = presentHero(summary)
    expect(hero.others[0]?.overdue?.amount).toBe("300.00")
    expect(hero.overdue?.bucket.amount).toBe("8750.00")
    // The oldest age is one number for all currencies, so it is not claimed for the DKK figure.
    expect(hero.overdue?.oldestDaysOverdue).toBeNull()
  })

  it("never reads the unvalued subset: it is part of the buckets, not extra money", () => {
    const summary = activeSummary()
    summary.outstanding.unvalued = [bucket("DKK", "20000.00", 3)]
    summary.overdue.unvalued = [bucket("DKK", "8750.00")]
    const hero = presentHero(summary)
    expect(hero.outstanding?.amount).toBe("20000.00")
    expect(hero.segments).toEqual(presentHero(activeSummary()).segments)
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

  it("trusts the oldest overdue age when overdue money is in one currency", () => {
    expect(presentHero(activeSummary()).overdue?.oldestDaysOverdue).toBe(14)
  })
})

describe("presentChart", () => {
  it("draws the base currency only and says when other currencies were left out", () => {
    const chart = presentChart(activeSummary())
    expect(chart.currency).toBe("DKK")
    expect(chart.months).toHaveLength(12)
    expect(chart.months[11]).toMatchObject({ amount: "10000.00", isCurrent: true })
    // The EUR month is not drawn as DKK.
    expect(chart.months[5]).toMatchObject({ amount: null, value: 0 })
    expect(chart.hasOtherCurrencies).toBe(true)
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
    expect(dueLabel({ dueDate: "2026-09-24", daysOverdue: 14 }, today)).toEqual({ kind: "overdue", days: 14 })
    expect(dueLabel({ dueDate: "2026-10-08", daysOverdue: 0 }, today)).toEqual({ kind: "today" })
    expect(dueLabel({ dueDate: "2026-10-09", daysOverdue: 0 }, today)).toEqual({ kind: "tomorrow" })
    expect(dueLabel({ dueDate: "2026-10-18", daysOverdue: 0 }, today)).toEqual({ kind: "later", days: 10 })
  })
})

describe("attention", () => {
  const [overdue, draft] = activeSummary().attention

  it("finds how late an overdue invoice is from the incoming list", () => {
    expect(overdueDaysFor(overdue!, activeSummary().incoming)).toBe(14)
    expect(overdueDaysFor(draft!, activeSummary().incoming)).toBeNull()
    expect(overdueDaysFor(overdue!, [])).toBeNull()
  })

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
