import { DASHBOARD_ACTIVITY_EVENT_TYPES, type DashboardMoney, type DashboardSummary, type DashboardTotal } from "@quits/contracts/dashboard"
import { requireCurrencyExponent } from "@quits/shared/currency"
import { Prisma, type PrismaClient } from "../../../generated/prisma/client"
import { actorCan, type UserActor } from "../../domain/actor"
import { isValidRecipient, reminderBlocker, utcTimestamp } from "../../domain/commands/reminders"
import { resolveInvoiceEmailContext } from "../../domain/documents/invoice-email"
import { computeSettlement } from "../../domain/documents/settlement"
import { formatIsoDate, startOfDayInTimeZone } from "../exports/format"

type Db = Prisma.TransactionClient
const DAY_MS = 86_400_000
const money = (currency: string, amount: Prisma.Decimal): DashboardMoney => {
  const exponent = requireCurrencyExponent(currency)
  return { currency, exponent, amount: amount.toFixed(exponent) }
}

function totals() {
  const buckets = new Map<string, { amount: Prisma.Decimal; count: number; oldestDaysOverdue?: number }>()
  const unvalued = new Map<string, { amount: Prisma.Decimal; count: number; oldestDaysOverdue?: number }>()
  return {
    add(currency: string, amount: Prisma.Decimal, count: number, hasValuation = false, oldestDaysOverdue?: number) {
      for (const map of hasValuation ? [buckets] : [buckets, unvalued]) {
        const old = map.get(currency) ?? { amount: new Prisma.Decimal(0), count: 0 }
        map.set(currency, {
          amount: old.amount.plus(amount), count: old.count + count,
          ...(oldestDaysOverdue === undefined ? {} : { oldestDaysOverdue: Math.max(old.oldestDaysOverdue ?? 0, oldestDaysOverdue) }),
        })
      }
    },
    result(): DashboardTotal {
      const serialize = (map: typeof buckets) => [...map].sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, value]) => ({ ...money(currency, value.amount), count: value.count, ...(value.oldestDaysOverdue === undefined ? {} : { oldestDaysOverdue: value.oldestDaysOverdue }) }))
      const values = serialize(buckets)
      return { count: values.reduce((sum, value) => sum + value.count, 0), buckets: values, unvalued: serialize(unvalued) }
    },
  }
}

type InvoiceRow = {
  id: string; number: string | null; customerName: string; email: string | null
  status: string; currency: string; dueDate: Date; createdAt: Date; paidAt: Date | null
  totalGross: Prisma.Decimal; amountPaid: Prisma.Decimal; amountCredited: Prisma.Decimal
  hasValuation: boolean; reminderSlotTaken: boolean; lastEmailAttemptOutcome: string | null
}

/**
 * The invoice list and payment status own this arithmetic. Keep this boundary when #72 lands:
 * receipt allocations continue to maintain amountPaid/amountCredited through refreshInvoiceSettlement.
 * No relation loads, money conversion, or alternative SQL settlement formula here.
 */
export function amountStillOwed(invoice: Parameters<typeof computeSettlement>[0]) {
  return computeSettlement(invoice).balanceDue
}

async function readInvoices(db: Db, organizationId: string, baseCurrency: string, now: Date) {
  // Narrow rows, no snapshots or line items. Existing organization indexes bound this scan;
  // the reminder's unique (invoiceId, offsetDays) index serves the single joined slot.
  return db.$queryRaw<InvoiceRow[]>`
    SELECT i.id, i.number, i.status, i.currency, i."dueDate", i."createdAt", i."paidAt",
      i."totalGross", i."amountPaid", i."amountCredited", i."lastEmailAttemptOutcome",
      c.name AS "customerName", c.email,
      COALESCE(i.valuation->>'rateSource' <> 'unknown'
        AND i.valuation->'base'->>'minor' IS NOT NULL
        AND i.valuation->'base'->>'currency' = ${baseCurrency}, false) AS "hasValuation",
      (r.id IS NOT NULL AND (r.outcome IS NULL OR r.outcome IN ('sent', 'unconfirmed', 'sending'))) AS "reminderSlotTaken"
    FROM invoice i
    JOIN contact c ON c.id = i."contactId" AND c."organizationId" = i."organizationId"
    LEFT JOIN invoice_reminder r ON r."invoiceId" = i.id
      AND r."offsetDays" = floor(extract(epoch FROM (${utcTimestamp(now)} - i."dueDate")) / 86400)
    WHERE i."organizationId" = ${organizationId}
  `
}

/** Complete draft inventory, independent of the attention/event caps. In-flight sends are locked. */
async function openDrafts(db: Db, actor: UserActor): Promise<DashboardSummary["drafts"]> {
  const rows = await db.$queryRaw<DashboardSummary["drafts"][]>`
    SELECT count(*) OVER ()::int AS count, id AS "newestId", kind AS "newestKind"
    FROM (
      SELECT id, "createdAt", 'invoice' AS kind FROM invoice
      WHERE "organizationId" = ${actor.organizationId} AND ${actorCan(actor, "invoice:read")}
        AND status = 'draft' AND "lastEmailAttemptOutcome" IS DISTINCT FROM 'sending'
      UNION ALL
      SELECT id, "createdAt", 'quote' AS kind FROM quote
      WHERE "organizationId" = ${actor.organizationId} AND ${actorCan(actor, "quote:read")}
        AND status = 'draft' AND "lastEmailAttemptOutcome" IS DISTINCT FROM 'sending'
    ) drafts
    ORDER BY "createdAt" DESC, id DESC, kind DESC LIMIT 1
  `
  return rows[0] ?? { count: 0, newestId: null, newestKind: null }
}

/**
 * Active payment rows are receipts on this baseline. After #72, union legacy Payment rows
 * (receiptId IS NULL) with active SettlementReceipt.netAmount, once per receipt, by paidAt.
 * Never sum receipt allocations as cash. Count is receipt/payment records, not invoice count.
 */
export async function moneyReceived(db: Db, organizationId: string, timezone: string, start: Date, now: Date) {
  return db.$queryRaw<Array<{ month: string; currency: string; amount: Prisma.Decimal; count: number }>>`
    SELECT to_char(("paidAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timezone}, 'YYYY-MM') AS month,
      currency, sum(amount) AS amount, count(*)::int AS count
    FROM payment
    WHERE "organizationId" = ${organizationId} AND "voidedAt" IS NULL
      AND "paidAt" >= ${utcTimestamp(start)} AND "paidAt" <= ${utcTimestamp(now)}
    GROUP BY month, currency
  `
}

/**
 * Document events are readable by all current invoice-reading member roles. Do not expose the
 * organization audit log's settings/agent events or raw payloads through invoice:read.
 * #74 retains DomainEvent; replacing this projection with a bulk journal adapter is local here.
 */
export async function recentActivity(db: Db, organizationId: string): Promise<DashboardSummary["activity"]> {
  // Filter before LIMIT. Resolve at most eight rows in this same statement/snapshot, with
  // organization checks on every join. Payment events normally aggregate on invoices; older
  // payment aggregates are resolved through their scoped Payment row. Never read event payloads.
  const events = await db.$queryRaw<Array<Omit<DashboardSummary["activity"][number], "occurredAt"> & { occurredAt: Date }>>`
    SELECT e.id, e.sequence, e.type, e."aggregateType", e."aggregateId", e."occurredAt",
      CASE WHEN i.id IS NOT NULL THEN 'invoice' WHEN q.id IS NOT NULL THEN 'quote'
        WHEN cn.id IS NOT NULL THEN 'credit_note' WHEN a.id IS NOT NULL THEN 'agreement'
        ELSE NULL END AS "documentKind",
      CASE WHEN coalesce(i.status, q.status, cn.status, a.status) = 'draft' THEN NULL
        ELSE coalesce(i.number, q.number, cn.number, a.number) END AS "documentNumber",
      c.name AS "customerName"
    FROM (
      SELECT id, sequence, type, "aggregateType", "aggregateId", "occurredAt", "organizationId"
      FROM domain_event
      WHERE "organizationId" = ${organizationId}
        AND type IN (${Prisma.join(DASHBOARD_ACTIVITY_EVENT_TYPES)})
        AND "aggregateType" IN ('invoice', 'payment', 'quote', 'creditNote', 'credit_note', 'agreement')
      ORDER BY sequence DESC LIMIT 8
    ) e
    LEFT JOIN payment p ON e."aggregateType" = 'payment' AND p.id = e."aggregateId"
      AND p."organizationId" = e."organizationId"
    LEFT JOIN invoice i ON i."organizationId" = e."organizationId" AND (
      (e."aggregateType" = 'invoice' AND i.id = e."aggregateId") OR
      (e."aggregateType" = 'payment' AND i.id = p."invoiceId")
    )
    LEFT JOIN quote q ON e."aggregateType" = 'quote' AND q.id = e."aggregateId"
      AND q."organizationId" = e."organizationId"
    LEFT JOIN credit_note cn ON e."aggregateType" IN ('credit_note', 'creditNote') AND cn.id = e."aggregateId"
      AND cn."organizationId" = e."organizationId"
    LEFT JOIN agreement a ON e."aggregateType" = 'agreement' AND a.id = e."aggregateId"
      AND a."organizationId" = e."organizationId"
    LEFT JOIN contact c ON c.id = coalesce(i."contactId", q."contactId", cn."contactId", a."contactId")
      AND c."organizationId" = e."organizationId"
    ORDER BY e.sequence DESC
  `
  return events.map(event => ({ ...event, occurredAt: event.occurredAt.toISOString() }))
}

/**
 * Walk currently payment-settled issued invoices, newest paidAt first, id descending for ties.
 * "Payment-settled" means positive gross, positive money paid, and zero remaining balance.
 * A qualifying invoice has its entire ORIGINAL gross covered by payments (no credit reduction)
 * and its latest active payment's calendar date is on/before its due date in the org timezone.
 * Stop at the first late or credit-assisted settlement. Unsettled invoices, zero-value invoices,
 * and invoices closed entirely by credit are excluded. Voids reopen invoices and remove them.
 * paidAt is maintained from the latest active payment by refreshInvoiceSettlement; this is a
 * current-state streak, not an immutable record of past streaks. Backdated payments can change it.
 */
export function onTimeStreak(invoices: InvoiceRow[], timezone: string) {
  const settled = invoices.filter(invoice => invoice.status !== "draft" && invoice.paidAt !== null
    && invoice.totalGross.gt(0) && invoice.amountPaid.gt(0) && amountStillOwed(invoice).isZero())
    .sort((a, b) => b.paidAt!.getTime() - a.paidAt!.getTime() || b.id.localeCompare(a.id))
  let streak = 0
  for (const invoice of settled) {
    if (invoice.amountPaid.lt(invoice.totalGross) || formatIsoDate(invoice.paidAt!, timezone) > formatIsoDate(invoice.dueDate, timezone)) break
    streak++
  }
  return streak
}

/** Six data statements in one repeatable-read snapshot, independent of invoice count. */
export async function dashboardSummary(db: PrismaClient, actor: UserActor, now = new Date()): Promise<DashboardSummary> {
  return db.$transaction(async tx => {
    const organizationId = actor.organizationId
    const settings = await tx.orgSettings.findUnique({ where: { organizationId } })
    const timezone = settings?.timezone ?? "UTC"
    const baseCurrency = settings?.baseCurrency ?? "USD"
    const today = formatIsoDate(now, timezone)
    const [year, month] = today.split("-").map(Number)
    const months = Array.from({ length: 12 }, (_, index) => new Date(Date.UTC(year!, month! - 12 + index, 1)).toISOString().slice(0, 7))
    const start = startOfDayInTimeZone(`${months[0]}-01`, timezone)
    const invoiceRows = await readInvoices(tx, organizationId, baseCurrency, now)
    const receipts = await moneyReceived(tx, organizationId, timezone, start, now)
    const quotes = await tx.$queryRaw<Array<{ id: string; number: string | null; customerName: string; totalGross: Prisma.Decimal; currency: string; status: string; createdAt: Date; expiryDate: Date }>>`
      SELECT q.id, q.number, c.name AS "customerName", q."totalGross", q.currency, q.status, q."createdAt", q."expiryDate"
      FROM quote q JOIN contact c ON c.id = q."contactId" AND c."organizationId" = q."organizationId"
      WHERE q."organizationId" = ${organizationId} AND (
        (q.status = 'draft' AND q."createdAt" < ${utcTimestamp(new Date(now.getTime() - 7 * DAY_MS))})
        OR (q.status IN ('sent', 'viewed')
          AND q."expiryDate" >= ${utcTimestamp(startOfDayInTimeZone(today, timezone))}
          AND q."expiryDate" < ${utcTimestamp(startOfDayInTimeZone(new Date(Date.parse(today) + 8 * DAY_MS).toISOString().slice(0, 10), timezone))})
      )
      ORDER BY CASE WHEN q.status = 'draft' THEN 0 ELSE 1 END,
        CASE WHEN q.status = 'draft' THEN q."createdAt" ELSE q."expiryDate" END, q.id LIMIT 5
    `
    const draftSummary = await openDrafts(tx, actor)
    const activity = await recentActivity(tx, organizationId)
    const outstanding = totals(), overdue = totals()
    const receivedByMonth = months.map(monthKey => {
      const total = totals()
      for (const receipt of receipts.filter(row => row.month === monthKey)) total.add(receipt.currency, receipt.amount, receipt.count)
      return { month: monthKey, ...total.result() }
    })
    const canSend = actorCan(actor, "invoice:send") && !!settings && resolveInvoiceEmailContext(settings).emailDelivery.available
    const canRemind = (invoice: InvoiceRow) => canSend && !reminderBlocker(invoice) && isValidRecipient(invoice.email) && !invoice.reminderSlotTaken
    const localDate = (date: Date) => formatIsoDate(date, timezone)
    // Same timestamp predicate as markOrganizationInvoicesOverdue; never depend on a stale
    // lifecycle badge or mutate invoices while reading the dashboard.
    const isOverdue = (invoice: InvoiceRow) => invoice.dueDate < now
    const daysOverdue = (invoice: InvoiceRow) => Math.max(0, Math.round((Date.parse(today) - Date.parse(localDate(invoice.dueDate))) / DAY_MS))
    const document = (invoice: Pick<InvoiceRow, "id" | "number" | "customerName" | "currency">, amount: Prisma.Decimal) => ({
      documentId: invoice.id, number: invoice.number, customerName: invoice.customerName, amount: money(invoice.currency, amount),
    })
    const open = invoiceRows.filter(invoice => invoice.status !== "draft" && amountStillOwed(invoice).gt(0))
      .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.id.localeCompare(b.id))
    let oldestDaysOverdue = 0
    for (const invoice of open) {
      const balance = amountStillOwed(invoice)
      outstanding.add(invoice.currency, balance, 1, invoice.hasValuation)
      const days = daysOverdue(invoice)
      if (isOverdue(invoice)) {
        overdue.add(invoice.currency, balance, 1, invoice.hasValuation, days)
        oldestDaysOverdue = Math.max(oldestDaysOverdue, days)
      }
    }
    const invoiceDates = (invoice: InvoiceRow) => ({
      dueDate: localDate(invoice.dueDate),
      daysOverdue: invoice.status === "draft" ? null : daysOverdue(invoice),
      isOverdue: invoice.status !== "draft" && amountStillOwed(invoice).gt(0) && isOverdue(invoice),
      expiresOn: null,
    })
    const quoteDates = { dueDate: null, daysOverdue: null, isOverdue: false, expiresOn: null }
    const attention: DashboardSummary["attention"] = open.filter(isOverdue)
      .map(invoice => ({ ...document(invoice, amountStillOwed(invoice)), ...invoiceDates(invoice), kind: "invoice", reason: "invoice_overdue", canRemind: canRemind(invoice) }))
    const drafts = [
      ...invoiceRows.filter(invoice => invoice.status === "draft" && invoice.createdAt.getTime() < now.getTime() - 7 * DAY_MS)
        .map(invoice => ({ ...invoice, kind: "invoice" as const })),
      ...quotes.filter(quote => quote.status === "draft").map(quote => ({ ...quote, kind: "quote" as const })),
    ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    attention.push(...drafts.map(draft => ({ ...document(draft, draft.totalGross), ...(draft.kind === "invoice" ? invoiceDates(draft) : quoteDates), kind: draft.kind, reason: "draft_older_than_7_days" as const, canRemind: false })))
    attention.push(...quotes.filter(quote => quote.status !== "draft").map(quote => ({ ...quoteDates, expiresOn: localDate(quote.expiryDate), documentId: quote.id, number: quote.number, customerName: quote.customerName, amount: money(quote.currency, quote.totalGross), kind: "quote" as const, reason: "quote_expiring" as const, canRemind: false })))
    // An uncertain submission is never labelled a bounce. This baseline has no bounce state.
    attention.push(...open.filter(invoice => !isOverdue(invoice) && ["failed", "unconfirmed"].includes(invoice.lastEmailAttemptOutcome ?? ""))
      .map(invoice => ({ ...document(invoice, amountStillOwed(invoice)), ...invoiceDates(invoice), kind: "invoice" as const, reason: invoice.lastEmailAttemptOutcome === "failed" ? "email_failed" as const : "email_unconfirmed" as const, canRemind: false })))
    const current = receivedByMonth.at(-1)!
    const outstandingTotal = outstanding.result()
    const overdueTotal = overdue.result()
    const hasOtherCurrencies = [outstandingTotal, overdueTotal, ...receivedByMonth]
      .some(total => [...total.buckets, ...total.unvalued].some(bucket => bucket.currency !== baseCurrency))
    return {
      asOf: now.toISOString(), timezone, baseCurrency, currencyMode: "per_currency", hasOtherCurrencies,
      outstanding: outstandingTotal, overdue: { ...overdueTotal, oldestDaysOverdue },
      paidThisMonth: { count: current.count, buckets: current.buckets, unvalued: current.unvalued },
      receivedByMonth, streak: onTimeStreak(invoiceRows, timezone), attention: attention.slice(0, 5),
      incoming: open.slice(0, 8).map(invoice => ({ ...document(invoice, amountStillOwed(invoice)), total: money(invoice.currency, invoice.totalGross), isOverdue: isOverdue(invoice), dueDate: localDate(invoice.dueDate), daysOverdue: daysOverdue(invoice), canRemind: canRemind(invoice) })),
      activity, drafts: draftSummary,
    }
  }, { isolationLevel: "RepeatableRead" })
}
