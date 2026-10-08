import { z } from "zod"
import { currencyCodeSchema } from "./baseSchemas"

const moneyFields = {
  currency: currencyCodeSchema,
  exponent: z.number().int().min(0).max(2),
  amount: z.string().regex(/^\d+(?:\.\d+)?$/),
}

function hasExactPrecision(value: { amount: string; exponent: number }) {
  const fraction = value.amount.split(".")[1]
  return value.exponent === 0 ? fraction === undefined : fraction?.length === value.exponent
}

export const dashboardMoneySchema = z.strictObject(moneyFields).refine(hasExactPrecision, {
  message: "Money must have exactly the currency exponent's decimal places",
})

export const dashboardBucketSchema = z.strictObject({
  ...moneyFields,
  count: z.number().int().nonnegative(),
}).refine(hasExactPrecision)

/**
 * Native currencies only, sorted by currency. Never add buckets across currencies.
 * `unvalued` is an informational SUBSET of `buckets`, not additional money. It identifies
 * documents without a known frozen valuation in the current base currency. Receipts currently
 * have no base valuation, so all received money also appears in `unvalued`.
 * Empty totals have count 0 and empty arrays; there is no ambiguous currency-free money zero.
 */
export const dashboardTotalSchema = z.strictObject({
  count: z.number().int().nonnegative(),
  buckets: z.array(dashboardBucketSchema),
  unvalued: z.array(dashboardBucketSchema),
})

const documentFields = {
  documentId: z.string(),
  number: z.string().nullable(),
  customerName: z.string(),
  amount: dashboardMoneySchema,
}

export const dashboardAttentionSchema = z.strictObject({
  ...documentFields,
  kind: z.enum(["invoice", "quote"]),
  reason: z.enum(["invoice_overdue", "draft_older_than_7_days", "quote_expiring", "email_failed", "email_unconfirmed"]),
  /** Eligibility now, including permission, recipient, provider and today's reminder slot.
   * The reminder command rechecks under its lock; a concurrent change can still refuse it. */
  canRemind: z.boolean(),
})

export const dashboardSummarySchema = z.strictObject({
  asOf: z.iso.datetime(),
  timezone: z.string(),
  baseCurrency: currencyCodeSchema,
  currencyMode: z.literal("per_currency"),
  outstanding: dashboardTotalSchema,
  /** Uses the existing dueDate < asOf predicate; same-day arrears have 0 calendar days overdue. */
  overdue: z.strictObject({ ...dashboardTotalSchema.shape, oldestDaysOverdue: z.number().int().nonnegative() }),
  paidThisMonth: dashboardTotalSchema,
  receivedByMonth: z.array(z.strictObject({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    ...dashboardTotalSchema.shape,
  })).length(12),
  streak: z.number().int().nonnegative(),
  attention: z.array(dashboardAttentionSchema).max(5),
  incoming: z.array(z.strictObject({ ...documentFields, dueDate: z.iso.date(), daysOverdue: z.number().int().nonnegative(), canRemind: z.boolean() })).max(8),
  /** Safe document-event metadata, newest organization sequence first. No audit payloads. */
  activity: z.array(z.strictObject({
    id: z.string(), sequence: z.number().int(), type: z.string(),
    aggregateType: z.string(), aggregateId: z.string(), occurredAt: z.iso.datetime(),
  })).max(8),
})

export type DashboardMoney = z.infer<typeof dashboardMoneySchema>
export type DashboardTotal = z.infer<typeof dashboardTotalSchema>
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>
