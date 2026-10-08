import type { VatRow } from "../../lib/documents/line-amounts"
import { toDecimal } from "../../lib/exports/format"
import { frozenVatRowsOrUndefined, rowsMatchingTotals } from "./frozen-vat-groups"
import { documentFractionDigits } from "./pricing"

type Amount = { toString(): string }
type Totals = { currency: string; subtotalNet: Amount; totalTax: Amount; totalGross: Amount }

/**
 * What the stored total carries beyond its stored net and tax: gross prices round the net and the
 * tax separately, so they can differ from the gross by one minor unit (UBL's PayableRoundingAmount).
 * Derived from the stored totals alone, as a decimal string in the currency's precision.
 */
export function payableRoundingOf(document: Totals): string {
  return toDecimal(document.totalGross.toString())
    .minus(document.subtotalNet.toString())
    .minus(document.totalTax.toString())
    .toFixed(documentFractionDigits(document.currency))
}

/**
 * The VAT rows and rounding a document prints between its subtotal and its total. Rows given by
 * the caller (the frozen groups of an issued invoice, the credited groups of a credit note) are
 * used when they account for the stored totals; otherwise the rows are grouped from the lines.
 */
export function documentVatSummary(
  document: Totals & Partial<Pick<Parameters<typeof frozenVatRowsOrUndefined>[0], "items" | "vatEvidence">>,
  rows?: readonly VatRow[]
): { vatRows: VatRow[] | undefined; rounding: string } {
  return {
    vatRows: rows ? rowsMatchingTotals(rows, document) : document.items ? frozenVatRowsOrUndefined({ ...document, items: document.items }) : undefined,
    rounding: payableRoundingOf(document),
  }
}
