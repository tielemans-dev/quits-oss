import type { TranslationKey } from "../i18n/messages"

/**
 * Which side of the VAT a document states its prices on. A document whose prices exclude VAT
 * (the usual case for business invoices) prints net unit prices and net line amounts, so the
 * lines add up to the subtotal; one whose prices include VAT prints gross ones, so they add up
 * to the total.
 */
export type PriceBasis = "net" | "gross"

export const priceBasis = (pricesIncludeTax: boolean | null | undefined): PriceBasis =>
  pricesIncludeTax ? "gross" : "net"

type LineAmountFields<Amount> = {
  unitPriceNet: Amount
  unitPriceGross: Amount
  lineNet: Amount
  lineGross: Amount
}

/**
 * The unit price and line amount a document prints for one line.
 *
 * This only chooses between stored values. Every amount was rounded and allocated when the
 * document was priced, and the lines of one basis sum to the stored subtotal (net) or total
 * (gross). Do no arithmetic on the result, and never derive one amount from the other.
 */
export function lineAmounts<Amount>(basis: PriceBasis, line: LineAmountFields<Amount>) {
  return basis === "gross"
    ? { unitPrice: line.unitPriceGross, amount: line.lineGross }
    : { unitPrice: line.unitPriceNet, amount: line.lineNet }
}

/**
 * The line table column headers for a basis. Without one, as for data frozen or served before
 * documents stated theirs, they stay the plain "Unit price" and "Total" rather than guess.
 */
export function lineColumnKeys(basis: PriceBasis | undefined): { unitPrice: TranslationKey; amount: TranslationKey } {
  if (!basis) return { unitPrice: "pdf.unitPrice", amount: "pdf.total" }
  return basis === "gross"
    ? { unitPrice: "pdf.unitPriceGross", amount: "pdf.amountGross" }
    : { unitPrice: "pdf.unitPriceNet", amount: "pdf.amountNet" }
}

/** VAT of one rate. Amounts are decimal strings in the document's currency. */
export type VatRow = { ratePercent: string; net: string; tax: string; gross: string }

const isZero = (amount: string) => !/[1-9]/.test(amount)

/**
 * The VAT rows a document prints under its subtotal: one per rate. A document with a single zero
 * rate prints none, as before; one that mixes rates keeps its zero-rated row so the reader can
 * see which part carried no VAT.
 */
export function printableVatRows(rows: readonly VatRow[]): VatRow[] {
  if (rows.length === 1 && isZero(rows[0]!.tax)) return []
  return [...rows]
}

/** The labels of the subtotal and total rows. Only a gross document says which side of the VAT they are on. */
export function totalsLabelKeys(basis: PriceBasis | undefined): { subtotal: TranslationKey; total: TranslationKey } {
  return basis === "gross"
    ? { subtotal: "pdf.subtotalExclTax", total: "pdf.totalInclTax" }
    : { subtotal: "pdf.subtotal", total: "pdf.total" }
}
