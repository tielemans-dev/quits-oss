import type { DashboardSummary, DashboardTotal } from "@quits/contracts/dashboard"
import { getCurrencyExponent } from "@quits/shared/currency"

import { minorToDecimal } from "../kvit/amount-format"

/**
 * What the dashboard shows, worked out from `dashboard.summary()` and nothing else. Pure, so the
 * money rules can be tested without rendering:
 *
 * - Money is per currency. Nothing here adds or converts across currencies; the hero is one
 *   currency and every other one is a secondary line of its own.
 * - `unvalued` is a subset of `buckets` (money without a base valuation). It is never read here,
 *   so it can never be shown as extra money.
 */

export type Summary = DashboardSummary
export type Bucket = DashboardTotal["buckets"][number]
export type AttentionItem = Summary["attention"][number]
export type IncomingItem = Summary["incoming"][number]
export type ActivityEvent = Summary["activity"][number]

/**
 * first-run: nothing has happened, so show no figures at all.
 * getting-started: drafts or events exist but no money has moved, so there is nothing to total yet.
 * active: money is owed. kvit: money has moved and none is owed, which is the good state.
 */
export type DashboardState = "first-run" | "getting-started" | "active" | "kvit"

export function classifyDashboard(summary: Summary): DashboardState {
  const hasMoney =
    summary.outstanding.count > 0 ||
    summary.paidThisMonth.count > 0 ||
    summary.receivedByMonth.some((month) => month.count > 0)
  if (hasMoney) return summary.outstanding.count > 0 ? "active" : "kvit"
  const hasSomething =
    summary.attention.length > 0 || summary.incoming.length > 0 || summary.activity.length > 0
  return hasSomething ? "getting-started" : "first-run"
}

export function bucketFor(total: DashboardTotal, currency: string): Bucket | null {
  return total.buckets.find((bucket) => bucket.currency === currency) ?? null
}

/** The digits of an exact decimal string as minor units. "12.50" is 1250n; "7" with exponent 0 is 7n. */
export function toMinor(money: { amount: string; exponent: number }): bigint {
  const [whole = "0", fraction = ""] = money.amount.split(".")
  return BigInt(`${whole}${fraction.padEnd(money.exponent, "0").slice(0, money.exponent)}`)
}

function exponentOf(currency: string, buckets: Bucket[]): number {
  return buckets[0]?.exponent ?? getCurrencyExponent(currency) ?? 2
}

export type HeroModel = {
  /** The currency of the big figure: the base currency, unless money is only owed in another one. */
  currency: string
  /** null when nothing is owed in `currency`. */
  outstanding: Bucket | null
  overdue: { bucket: Bucket; oldestDaysOverdue: number | null } | null
  /** Received this month, in `currency`. */
  paid: Bucket | null
  /** Shares of paid, on its way and overdue, summing to 1; null when all three are zero. */
  segments: { paid: number; pending: number; overdue: number } | null
  /** Every other currency that is owed, each on its own line. */
  others: Array<{ currency: string; outstanding: Bucket; overdue: Bucket | null }>
}

export function presentHero(summary: Summary): HeroModel {
  const { baseCurrency, outstanding, overdue, paidThisMonth } = summary
  const owed = outstanding.buckets
  const currency =
    owed.length === 0 || owed.some((bucket) => bucket.currency === baseCurrency)
      ? baseCurrency
      : owed[0]!.currency

  const owedBucket = bucketFor(outstanding, currency)
  const overdueBucket = bucketFor(overdue, currency)
  const paidBucket = bucketFor(paidThisMonth, currency)

  const owedMinor = owedBucket ? toMinor(owedBucket) : 0n
  const overdueMinor = overdueBucket ? toMinor(overdueBucket) : 0n
  const paidMinor = paidBucket ? toMinor(paidBucket) : 0n
  const pendingMinor = owedMinor > overdueMinor ? owedMinor - overdueMinor : 0n
  const total = paidMinor + pendingMinor + overdueMinor

  return {
    currency,
    outstanding: owedBucket,
    overdue: overdueBucket
      ? {
          bucket: overdueBucket,
          // The oldest age is one number for all currencies; only trust it when overdue money is
          // in a single currency, so it cannot belong to an invoice in another one.
          oldestDaysOverdue: overdue.buckets.length === 1 ? overdue.oldestDaysOverdue : null,
        }
      : null,
    paid: paidBucket,
    segments:
      total === 0n
        ? null
        : {
            paid: Number(paidMinor) / Number(total),
            pending: Number(pendingMinor) / Number(total),
            overdue: Number(overdueMinor) / Number(total),
          },
    others: owed
      .filter((bucket) => bucket.currency !== currency)
      .map((bucket) => ({
        currency: bucket.currency,
        outstanding: bucket,
        overdue: bucketFor(overdue, bucket.currency),
      })),
  }
}

export type ChartModel = {
  currency: string
  months: Array<{ month: string; amount: string | null; value: number; isCurrent: boolean }>
  /** The twelve months added up, in `currency`: one currency, so the sum is honest. */
  total: string
  hasData: boolean
  /** True when money was also received in another currency, which this chart does not draw. */
  hasOtherCurrencies: boolean
}

export function presentChart(summary: Summary): ChartModel {
  const currency = summary.baseCurrency
  const exponent = exponentOf(
    currency,
    summary.receivedByMonth.flatMap((month) => month.buckets.filter((b) => b.currency === currency))
  )
  let sum = 0n
  let hasOtherCurrencies = false
  const months = summary.receivedByMonth.map((entry, index, all) => {
    const bucket = bucketFor(entry, currency)
    if (entry.buckets.some((other) => other.currency !== currency)) hasOtherCurrencies = true
    if (bucket) sum += toMinor(bucket)
    return {
      month: entry.month,
      amount: bucket?.amount ?? null,
      value: bucket ? Number(bucket.amount) : 0,
      isCurrent: index === all.length - 1,
    }
  })
  return {
    currency,
    months,
    total: minorToDecimal(sum, exponent),
    hasData: months.some((month) => month.amount !== null),
    hasOtherCurrencies,
  }
}

/** Streaks of one are just an invoice that was paid; only a run is worth a line. */
export const STREAK_MINIMUM = 2

export function streakVisible(streak: number): boolean {
  return streak >= STREAK_MINIMUM
}

/** Today in the organization's time zone, as YYYY-MM-DD. */
export function localToday(asOf: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(asOf))
}

const DAY_MS = 86_400_000

export function daysBetween(fromIsoDate: string, toIsoDate: string): number {
  return Math.round((Date.parse(toIsoDate) - Date.parse(fromIsoDate)) / DAY_MS)
}

export type DueLabel =
  | { kind: "overdue"; days: number }
  | { kind: "today" }
  | { kind: "tomorrow" }
  | { kind: "later"; days: number }

/**
 * When an incoming invoice is due. `daysOverdue` is 0 both for "due today" and for "past its due
 * time today", so a zero is read as today.
 */
export function dueLabel(item: Pick<IncomingItem, "dueDate" | "daysOverdue">, today: string): DueLabel {
  if (item.daysOverdue > 0) return { kind: "overdue", days: item.daysOverdue }
  const days = daysBetween(today, item.dueDate)
  if (days <= 0) return { kind: "today" }
  if (days === 1) return { kind: "tomorrow" }
  return { kind: "later", days }
}

/**
 * How late an overdue invoice in the attention list is. The attention list carries no due date,
 * but it is a prefix of the incoming list (both sort by due date), so the days are found there.
 */
export function overdueDaysFor(item: AttentionItem, incoming: IncomingItem[]): number | null {
  if (item.reason !== "invoice_overdue") return null
  return incoming.find((candidate) => candidate.documentId === item.documentId)?.daysOverdue ?? null
}

/** Whether an attention row's one action is "send a reminder", the only one that is not a link. */
export function attentionAction(item: AttentionItem): "remind" | "open" {
  return item.reason === "invoice_overdue" && item.canRemind ? "remind" : "open"
}
