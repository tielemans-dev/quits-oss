import type { Summary } from "../summary-model"

export const bucket = (currency: string, amount: string, count = 1) => ({
  currency,
  amount,
  count,
  exponent: currency === "JPY" ? 0 : 2,
})

export const total = (...buckets: ReturnType<typeof bucket>[]) => ({
  count: buckets.reduce((sum, item) => sum + item.count, 0),
  buckets,
  unvalued: [] as ReturnType<typeof bucket>[],
})

export const emptyTotal = () => ({ count: 0, buckets: [], unvalued: [] })

export const MONTHS = Array.from({ length: 12 }, (_, index) => {
  const date = new Date(Date.UTC(2025, 10 + index, 1))
  return date.toISOString().slice(0, 7)
})

/** An organization with nothing in it: the API's own empty summary. */
export function emptySummary(overrides: Partial<Summary> = {}): Summary {
  return {
    asOf: "2026-10-08T12:00:00.000Z",
    timezone: "Europe/Copenhagen",
    baseCurrency: "DKK",
    currencyMode: "per_currency",
    outstanding: emptyTotal(),
    overdue: { ...emptyTotal(), oldestDaysOverdue: 0 },
    paidThisMonth: emptyTotal(),
    receivedByMonth: MONTHS.map((month) => ({ month, ...emptyTotal() })),
    streak: 0,
    attention: [],
    incoming: [],
    activity: [],
    ...overrides,
  }
}

export const money = (currency: string, amount: string) => ({
  currency,
  amount,
  exponent: currency === "JPY" ? 0 : 2,
})

/** Money is owed in DKK and EUR, some of it overdue, with a streak and a few events. */
export function activeSummary(overrides: Partial<Summary> = {}): Summary {
  return emptySummary({
    outstanding: total(bucket("DKK", "20000.00", 3), bucket("EUR", "1800.00", 1)),
    overdue: { ...total(bucket("DKK", "8750.00", 1)), oldestDaysOverdue: 14 },
    paidThisMonth: total(bucket("DKK", "10000.00", 2)),
    receivedByMonth: MONTHS.map((month, index) => ({
      month,
      ...(index === 11 ? total(bucket("DKK", "10000.00", 2)) : index === 5 ? total(bucket("EUR", "500.00")) : emptyTotal()),
    })),
    streak: 12,
    attention: [
      {
        documentId: "inv-overdue",
        number: "2026-115",
        customerName: "Havn Studio",
        amount: money("DKK", "8750.00"),
        kind: "invoice",
        reason: "invoice_overdue",
        canRemind: true,
      },
      {
        documentId: "inv-draft",
        number: null,
        customerName: "Bølge Bryg",
        amount: money("DKK", "14500.00"),
        kind: "invoice",
        reason: "draft_older_than_7_days",
        canRemind: false,
      },
    ],
    incoming: [
      {
        documentId: "inv-overdue",
        number: "2026-115",
        customerName: "Havn Studio",
        amount: money("DKK", "8750.00"),
        dueDate: "2026-09-24",
        daysOverdue: 14,
        canRemind: true,
      },
      {
        documentId: "inv-soon",
        number: "2026-117",
        customerName: "Nordlys ApS",
        amount: money("DKK", "11250.00"),
        dueDate: "2026-10-11",
        daysOverdue: 0,
        canRemind: false,
      },
    ],
    activity: [
      { id: "e1", sequence: 3, type: "invoice.paid", aggregateType: "invoice", aggregateId: "inv-paid", occurredAt: "2026-10-07T10:00:00.000Z" },
    ],
    ...overrides,
  })
}
