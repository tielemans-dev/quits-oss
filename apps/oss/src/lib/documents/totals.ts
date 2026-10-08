import { formatCurrency, formatNumber } from "../i18n/format"
import { translate } from "../i18n/translate"
import { printableVatRows, totalsLabelKeys, type PriceBasis, type VatRow } from "./line-amounts"

export type TotalsRow = { kind: "subtotal" | "tax" | "rounding" | "total"; label: string; amount: string }

/**
 * The rows under a document's line table, shared by every surface that prints them: the PDFs, the
 * detail pages and the emails. `lines` are the subtotal, one VAT row per rate, and a rounding row
 * when the stored total differs from net plus tax; `total` closes them. Amounts are decimal strings,
 * and the rounding is the stored total minus the stored subtotal and tax, so the printed subtotal
 * plus the printed VAT rows plus the rounding is exactly the printed total.
 *
 * With one VAT row it reads "Moms (25 %)"; with several each names its taxable amount, as the VAT
 * directive requires ("Moms 25 % af 8.000,00 kr.").
 */
export function buildTotals(input: {
  basis: PriceBasis | undefined
  subtotal: number | string
  taxAmount: number | string
  total: number | string
  vatRows?: readonly VatRow[] | null
  rounding?: string | null
  currency: string
  locale?: string | null
}): { lines: TotalsRow[]; total: TotalsRow } {
  const { currency, locale } = input
  const keys = totalsLabelKeys(input.basis)
  const money = (amount: string) => formatCurrency(Number(amount), currency, locale)
  const rate = (row: VatRow) => formatNumber(Number(row.ratePercent), locale)
  const lines: TotalsRow[] = [{ kind: "subtotal", label: translate(keys.subtotal, locale), amount: String(input.subtotal) }]
  if (input.vatRows?.length) {
    const rows = printableVatRows(input.vatRows)
    for (const row of rows) {
      lines.push({
        kind: "tax",
        label: rows.length > 1
          ? translate("pdf.taxRateOf", locale, { rate: rate(row), base: money(row.net) })
          : translate("pdf.taxRate", locale, { rate: rate(row) }),
        amount: row.tax,
      })
    }
  } else if (Number(input.taxAmount) > 0) {
    lines.push({ kind: "tax", label: translate("pdf.tax", locale), amount: String(input.taxAmount) })
  }
  if (input.rounding && /[1-9]/.test(input.rounding)) {
    lines.push({ kind: "rounding", label: translate("pdf.rounding", locale), amount: input.rounding })
  }
  return { lines, total: { kind: "total", label: translate(keys.total, locale), amount: String(input.total) } }
}
