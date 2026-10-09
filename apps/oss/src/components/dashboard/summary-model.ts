import type { DashboardSummary, DashboardTotal } from "@quits/contracts/dashboard"
import { getCurrencyExponent } from "@quits/shared/currency"

import { minorToDecimal } from "../kvit/amount-format"

/**
 * What the dashboard shows, worked out from `dashboard.summary()` and nothing else. Pure, so the
 * money rules can be tested without rendering:
 *
 * - Money is per currency. Nothing here adds or converts across currencies; the hero is one
 *   currency and every other one is a secondary line of its own.
 * - `unvalued` overlaps `buckets` for supported currencies (money without a base valuation), so it
 *   is never added to anything. It is read for one purpose only: a currency that is in `unvalued`
 *   and in none of the valued `buckets` (an unknown or three-decimal currency) exists nowhere else,
 *   so it is shown once, on a line of its own. See `bucketFor` and `currenciesOf`.
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
    summary.drafts.count > 0 ||
    summary.attention.length > 0 ||
    summary.incoming.length > 0 ||
    summary.activity.length > 0
  return hasSomething ? "getting-started" : "first-run"
}

export function bucketFor(total: DashboardTotal, currency: string): Bucket | null {
  return (
    total.buckets.find((bucket) => bucket.currency === currency) ??
    // Only reached for a currency absent from every valued bucket, so it is never a second
    // figure for money already counted.
    total.unvalued.find((bucket) => bucket.currency === currency) ??
    null
  )
}

/** The valued currencies of a total, then those that appear only in `unvalued`, each once. */
export function currenciesOf(total: DashboardTotal): string[] {
  const valued = total.buckets.map((bucket) => bucket.currency)
  const unvaluedOnly = total.unvalued
    .map((bucket) => bucket.currency)
    .filter((currency) => !valued.includes(currency))
  return [...valued, ...unvaluedOnly]
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
  /** `oldestDaysOverdue` is the oldest age within this currency; null when the bucket has none. */
  overdue: { bucket: Bucket; oldestDaysOverdue: number | null } | null
  /** Received this month, in `currency`. */
  paid: Bucket | null
  /** Shares of paid, on its way and overdue, summing to 1; null when all three are zero. */
  segments: { paid: number; pending: number; overdue: number } | null
  /** Every other currency that is owed, valued or only unvalued, each once on its own line. */
  others: Array<{ currency: string; outstanding: Bucket; overdue: Bucket | null }>
}

export function presentHero(summary: Summary): HeroModel {
  const { baseCurrency, outstanding, overdue, paidThisMonth } = summary
  const owed = currenciesOf(outstanding)
  const currency = owed.length === 0 || owed.includes(baseCurrency) ? baseCurrency : owed[0]!

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
      ? { bucket: overdueBucket, oldestDaysOverdue: overdueBucket.oldestDaysOverdue ?? null }
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
      .filter((other) => other !== currency)
      .map((other) => ({
        currency: other,
        outstanding: bucketFor(outstanding, other)!,
        overdue: bucketFor(overdue, other),
      })),
  }
}

export type ChartModel = {
  currency: string
  months: Array<{ month: string; amount: string | null; value: number; isCurrent: boolean }>
  /** The twelve months added up, in `currency`: one currency, so the sum is honest. */
  total: string
  hasData: boolean
  /** The summary's own flag: some amount is in another currency, which this chart does not draw. */
  hasOtherCurrencies: boolean
}

export function presentChart(summary: Summary): ChartModel {
  const currency = summary.baseCurrency
  const exponent = exponentOf(
    currency,
    summary.receivedByMonth.flatMap((month) => month.buckets.filter((b) => b.currency === currency))
  )
  let sum = 0n
  const months = summary.receivedByMonth.map((entry, index, all) => {
    const bucket = bucketFor(entry, currency)
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
    hasOtherCurrencies: summary.hasOtherCurrencies,
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
 * When an incoming invoice is due. Overdue is the server's `isOverdue`, but never with zero days:
 * the server also flags an invoice due today as overdue for now, and "0 days overdue" must not be
 * shown. Zero days reads as due today, in the neutral tone. Otherwise the days to the due date are
 * counted from the organization's today.
 */
export function dueLabel(
  item: Pick<IncomingItem, "dueDate" | "daysOverdue" | "isOverdue">,
  today: string
): DueLabel {
  if (item.isOverdue && item.daysOverdue > 0) return { kind: "overdue", days: item.daysOverdue }
  const days = daysBetween(today, item.dueDate)
  if (days <= 0) return { kind: "today" }
  if (days === 1) return { kind: "tomorrow" }
  return { kind: "later", days }
}

/**
 * How much of an incoming invoice is settled, for the second rule: `1 - balance/total` from exact
 * minor units, so payments and credits both count, as in the lists. The share only draws the
 * rule; it never feeds an amount. Nothing settled is a single rule.
 */
export function incomingRule(item: Pick<IncomingItem, "amount" | "total">): {
  rule: "single" | "double"
  paidFraction?: number
} {
  const total = toMinor(item.total)
  const balance = toMinor(item.amount)
  if (total <= 0n || balance >= total) return { rule: "single" }
  if (balance <= 0n) return { rule: "double" }
  return { rule: "double", paidFraction: Number(total - balance) / Number(total) }
}

/** Red only for a real arrear: the server's `isOverdue` with at least one day, never "0 days". */
export function isLate(item: { isOverdue: boolean; daysOverdue: number | null }): boolean {
  return item.isOverdue && (item.daysOverdue ?? 0) > 0
}

/** Whether an attention row's one action is "send a reminder", the only one that is not a link. */
export function attentionAction(item: AttentionItem): "remind" | "open" {
  return item.reason === "invoice_overdue" && item.canRemind ? "remind" : "open"
}
