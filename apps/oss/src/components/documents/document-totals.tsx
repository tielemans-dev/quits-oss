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
}: {
  priceBasis?: PriceBasis
  subtotal: number
  taxAmount: number
  total: number
  vatRows?: readonly VatRow[] | null
  rounding?: string | null
  currency: string
}) {
  const { locale } = useI18n()
  const totals = buildTotals({ basis: priceBasis, subtotal, taxAmount, total, vatRows, rounding, currency, locale })
  const money = (amount: string) => formatCurrency(Number(amount), currency, locale)
  return (
    <>
      {totals.lines.map((row, index) => (
        <div key={index} className="flex justify-between">
          <span className="text-muted-foreground">{row.label}</span>
          <span className="num">{money(row.amount)}</span>
        </div>
      ))}
      <div className="flex justify-between font-semibold text-base border-t pt-2">
        <span>{totals.total.label}</span>
        <span className="num">{money(totals.total.amount)}</span>
      </div>
    </>
  )
}
