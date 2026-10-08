import { z } from "zod"
import { currencyCodeSchema } from "./baseSchemas"

/** User-facing events only. Server filtering and UI labels share this explicit list. */
export const DASHBOARD_ACTIVITY_EVENT_TYPES = [
  "invoice.sent", "invoice.issued", "invoice.email_resent", "invoice.draft_created",
  "invoice.paid", "payment.recorded", "payment.voided", "invoice.reminder_sent",
  "invoice.email_failed", "quote.email_failed", "credit_note.email_failed", "agreement.email_failed",
  "invoice.reminder_failed",
  "invoice.email_unconfirmed", "quote.email_unconfirmed", "credit_note.email_unconfirmed", "agreement.email_unconfirmed",
  "invoice.reminder_unconfirmed", "invoice.became_overdue", "credit_note.issued",
  "quote.sent", "quote.accepted", "quote.rejected", "quote.converted", "quote.draft_created",
  "agreement.sent", "agreement.offer_issued", "agreement.accepted",
] as const

export type DashboardActivityEventType = typeof DASHBOARD_ACTIVITY_EVENT_TYPES[number]

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
  /** Present only on overdue buckets, including their unvalued subset. */
  oldestDaysOverdue: z.number().int().nonnegative().optional(),
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
  /** Invoice due date, including drafts; null for quotes. */
  dueDate: z.iso.date().nullable(),
  /** Nonnegative calendar days for issued invoices; null for drafts and quotes. */
  daysOverdue: z.number().int().nonnegative().nullable(),
  /** True only for issued invoices with positive balance and dueDate < asOf. */
  isOverdue: z.boolean(),
  /** Local expiry date for quote_expiring; null for every other reason. */
  expiresOn: z.iso.date().nullable(),
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
  hasOtherCurrencies: z.boolean(),
  /** Editable, unsent drafts the member can read; newest by creation time, then id descending. */
  drafts: z.strictObject({
    count: z.number().int().nonnegative(),
    newestId: z.string().nullable(),
    newestKind: z.enum(["invoice", "quote"]).nullable(),
  }),
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
  incoming: z.array(z.strictObject({ ...documentFields, total: dashboardMoneySchema, isOverdue: z.boolean(), dueDate: z.iso.date(), daysOverdue: z.number().int().nonnegative(), canRemind: z.boolean() })).max(8),
  /** Safe document-event metadata, newest organization sequence first. No audit payloads. */
  activity: z.array(z.strictObject({
    id: z.string(), sequence: z.number().int(), type: z.string(),
    aggregateType: z.string(), aggregateId: z.string(), occurredAt: z.iso.datetime(),
    documentKind: z.enum(["invoice", "quote", "credit_note", "agreement"]).nullable(),
    documentNumber: z.string().nullable(),
    customerName: z.string().nullable(),
  })).max(8),
})

export type DashboardMoney = z.infer<typeof dashboardMoneySchema>
export type DashboardTotal = z.infer<typeof dashboardTotalSchema>
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>
