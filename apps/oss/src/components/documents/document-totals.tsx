import type { ReactNode } from "react"

import { useI18n } from "../../lib/i18n/react"
import { formatCurrency } from "../../lib/i18n/format"
import type { PriceBasis, VatRow } from "../../lib/documents/line-amounts"
import { buildTotals } from "../../lib/documents/totals"

/**
 * The subtotal, VAT, rounding and total rows of a document, built by the one function every
 * surface prints them with. Place it in the totals grid; rows that follow (paid, credited) are the
 * caller's.
 */
export function DocumentTotals({
  priceBasis,
  subtotal,
  taxAmount,
  total,
  vatRows,
  rounding,
  currency,
  renderAmount,
}: {
  priceBasis?: PriceBasis
  subtotal: number
  taxAmount: number
  total: number
  vatRows?: readonly VatRow[] | null
  rounding?: string | null
  currency: string
  /** Optional presentation for callers that need separator-aware tabular digits. */
  renderAmount?: (amount: string) => ReactNode
}) {
  const { locale } = useI18n()
  const totals = buildTotals({ basis: priceBasis, subtotal, taxAmount, total, vatRows, rounding, currency, locale })
  const money = (amount: string) => formatCurrency(Number(amount), currency, locale)
  const amount = renderAmount ?? ((value: string) => <span className="num">{money(value)}</span>)
  return (
    <>
      {totals.lines.map((row, index) => (
        <div key={index} className="flex justify-between">
          <span className="text-muted-foreground">{row.label}{row.reason && <small className="block text-xs">{row.reason}</small>}</span>
          {amount(row.amount)}
        </div>
      ))}
      <div className="flex justify-between font-semibold text-base border-t pt-2">
        <span>{totals.total.label}</span>
        {amount(totals.total.amount)}
      </div>
      {totals.note && <p className="rounded-md border p-3 text-xs text-muted-foreground">{totals.note}</p>}
    </>
  )
}
