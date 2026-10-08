import { frozenVatRowsOrUndefined } from "../../domain/documents/frozen-vat-groups"
import { lineAmounts, priceBasis } from "../../lib/documents/line-amounts"

type Amount = { toNumber: () => number }

/**
 * What a document's line table prints, beside the long-standing gross `unitPrice` and `total`
 * fields that external callers may still read. The amounts are the stored ones for the document's
 * price basis; the VAT rows are exact sums of the stored lines.
 */
export function lineDisplayForUi(
  document: { pricesIncludeTax: boolean },
  item: { unitPriceNet: Amount; unitPriceGross: Amount; lineNet: Amount; lineGross: Amount }
) {
  const shown = lineAmounts(priceBasis(document.pricesIncludeTax), item)
  return { displayUnitPrice: shown.unitPrice.toNumber(), displayAmount: shown.amount.toNumber() }
}

export function documentDisplayForUi(
  document: Parameters<typeof frozenVatRowsOrUndefined>[0] & { pricesIncludeTax: boolean }
) {
  return { priceBasis: priceBasis(document.pricesIncludeTax), vatRows: frozenVatRowsOrUndefined(document) }
}

