import type { Summary } from "../summary-model"

export const exponentOf = (currency: string) => (currency === "JPY" ? 0 : ["BHD", "KWD"].includes(currency) ? 3 : 2)

export const bucket = (currency: string, amount: string, count = 1, oldestDaysOverdue?: number) => ({
  currency,
  amount,
  count,
  exponent: exponentOf(currency),
  ...(oldestDaysOverdue === undefined ? {} : { oldestDaysOverdue }),
})

/** An unknown currency: its two decimals are the database's scale, not an ISO exponent. */
export const storageBucket = (currency: string, amount: string, count = 1) => ({
  ...bucket(currency, amount, count),
  exponent: 2,
  precisionSource: "storage" as const,
})

/** As the server sends an unvalued-only currency: counted in the total, present only in `unvalued`. */
export const unvaluedOnly = (...unvalued: ReturnType<typeof bucket>[]) => ({
  count: unvalued.reduce((sum, item) => sum + item.count, 0),
  buckets: [] as ReturnType<typeof bucket>[],
  unvalued,
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

type Summary_ = Summary
export const activityEvent = (
  overrides: Partial<Summary_["activity"][number]> & Pick<Summary_["activity"][number], "id" | "type" | "aggregateId">
): Summary_["activity"][number] => ({
  sequence: 1,
  aggregateType: overrides.type.split(".")[0] === "credit_note" ? "credit_note" : "invoice",
  occurredAt: "2026-10-07T10:00:00.000Z",
  documentKind: overrides.type.startsWith("quote") ? "quote" : "invoice",
  documentNumber: null,
  customerName: null,
  ...overrides,
})

/** A quote that is about to lapse, as the attention list carries it. */
export const quoteAttention = (): Summary_["attention"][number] => ({
  documentId: "quote-1",
  number: "T-2026-014",
  customerName: "Nordlys ApS",
  amount: money("DKK", "56000.00"),
  kind: "quote",
  dueDate: null,
  daysOverdue: null,
  isOverdue: false,
  expiresOn: "2026-10-12",
  reason: "quote_expiring",
  canRemind: false,
})

/** An organization with nothing in it: the API's own empty summary. */
export function emptySummary(overrides: Partial<Summary> = {}): Summary {
  return {
    asOf: "2026-10-08T12:00:00.000Z",
    timezone: "Europe/Copenhagen",
    baseCurrency: "DKK",
    currencyMode: "per_currency",
    hasOtherCurrencies: false,
    drafts: { count: 0, newestId: null, newestKind: null },
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
    hasOtherCurrencies: true,
    overdue: { ...total(bucket("DKK", "8750.00", 1, 14)), oldestDaysOverdue: 14 },
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
        dueDate: "2026-09-24",
        daysOverdue: 14,
        isOverdue: true,
        expiresOn: null,
        reason: "invoice_overdue",
        canRemind: true,
      },
      {
        documentId: "inv-draft",
        number: null,
        customerName: "Bølge Bryg",
        amount: money("DKK", "14500.00"),
        kind: "invoice",
        dueDate: "2026-10-22",
        daysOverdue: null,
        isOverdue: false,
        expiresOn: null,
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
        total: money("DKK", "8750.00"),
        isOverdue: true,
        dueDate: "2026-09-24",
        daysOverdue: 14,
        canRemind: true,
      },
      {
        documentId: "inv-soon",
        number: "2026-117",
        customerName: "Nordlys ApS",
        amount: money("DKK", "11250.00"),
        total: money("DKK", "11250.00"),
        isOverdue: false,
        dueDate: "2026-10-11",
        daysOverdue: 0,
        canRemind: false,
      },
    ],
    activity: [
      activityEvent({ id: "e1", type: "invoice.paid", aggregateId: "inv-paid", documentNumber: "2026-148", customerName: "Nordlys Studio" }),
    ],
    ...overrides,
  })
}
