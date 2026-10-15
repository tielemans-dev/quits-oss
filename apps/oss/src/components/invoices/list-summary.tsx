import type { DashboardSummary } from "@quits/contracts/dashboard"
import { useI18n } from "../../lib/i18n/react"
import { Amount } from "../kvit/amount"
import { precisionOf, secondaryBucket, unvaluedOnlyCurrencies } from "../dashboard/summary-model"

/** Reuse the ledger's exact, per-currency totals, including partial receipts this month. */
export function InvoiceListSummary({ summary }: { summary: DashboardSummary }) {
  const { t, locale } = useI18n()
  return <dl className="mb-6 grid divide-y rounded-xl border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
    {(["outstanding", "overdue", "paidThisMonth"] as const).map(kind => {
      const total = summary[kind]
      const currencies = [...total.buckets.map(bucket => bucket.currency), ...unvaluedOnlyCurrencies(total)]
      return <div key={kind} className="grid content-start gap-2 p-5">
        <dt className="text-sm text-muted-foreground">{t(`invoices.summary.${kind}`)}</dt>
        <dd className={kind === "overdue" ? "text-tone-warning" : kind === "paidThisMonth" ? "text-settled-text" : ""}>
          {currencies.length ? currencies.map(currency => {
            const bucket = secondaryBucket(total, currency)!
            return <div key={currency}><Amount value={bucket.amount} currency={currency} locale={locale} precision={precisionOf(bucket)} size="md" /></div>
          }) : <Amount value="0" currency={summary.baseCurrency} locale={locale} size="md" />}
        </dd>
        <dd className="text-xs text-muted-foreground">{t("invoices.summary.count", { count: total.count })}</dd>
      </div>
    })}
  </dl>
}
