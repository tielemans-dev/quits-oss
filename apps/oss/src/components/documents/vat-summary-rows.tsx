import { useI18n } from "../../lib/i18n/react"
import { formatCurrency, formatNumber } from "../../lib/i18n/format"
import { printableVatRows, type VatRow } from "../../lib/documents/line-amounts"

/**
 * The VAT lines of a document's totals: one per rate when the document carries them, else the
 * single tax amount. Place it between the subtotal and the total.
 */
export function VatSummaryRows({
  rows,
  taxAmount,
  currency,
}: {
  rows?: readonly VatRow[]
  taxAmount: number
  currency: string
}) {
  const { t, locale } = useI18n()
  const row = (label: string, amount: number, key: string) => (
    <div key={key} className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="num">{formatCurrency(amount, currency, locale)}</span>
    </div>
  )
  if (!rows) return taxAmount > 0 ? row(t("pdf.tax"), taxAmount, "tax") : null
  return printableVatRows(rows).map((vat) =>
    row(t("pdf.taxRate", { rate: formatNumber(Number(vat.ratePercent), locale) }), Number(vat.tax), vat.ratePercent)
  )
}
