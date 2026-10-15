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
export type VatRow = { ratePercent: string; net: string; tax: string; gross: string; treatment?: string; reasonCode?: string | null; treatments?: string[]; reasonCodes?: string[]; statements?: string[] }

const isZero = (amount: string) => !/[1-9]/.test(amount)

/**
 * The VAT rows a document prints under its subtotal: one per rate. A document with a single zero
 * unclassified rate prints none; classified zero rates retain their reason so the reader can
 * see which part carried no VAT.
 */
export function printableVatRows(rows: readonly VatRow[]): VatRow[] {
  if (rows.length === 1 && isZero(rows[0]!.ratePercent) && !vatReasonKeys(rows[0]!).length && !rows[0]!.statements?.length) return []
  return [...rows]
}

/** VAT-bearing documents state the side of VAT regardless of their line price basis. */
export function totalsLabelKeys(basis: PriceBasis | undefined, hasVat = basis === "gross", euVat = false): { subtotal: TranslationKey; total: TranslationKey } {
  return hasVat
    ? euVat ? { subtotal: "pdf.subtotalExclVat", total: "pdf.totalInclVat" } : { subtotal: "pdf.subtotalExclTax", total: "pdf.totalInclTax" }
    : { subtotal: "pdf.subtotal", total: "pdf.total" }
}

/**
 * The statement a document prints for a zero-VAT treatment, from the closed list of treatments and
 * reason codes. Exemptions cite the momsloven provision (Directive Art. 226(11)); reverse charge
 * says so (momsbekendtgørelsen §§ 60 and 62, stk. 1; Art. 226(11a)); intra-community goods cite the
 * exemption (§ 62, stk. 2). A treatment with no entry here prints nothing legal of its own.
 */
const vatStatementKeys: Record<string, TranslationKey> = {
  exempt: "pdf.vatStatement.exempt",
  zero_rated: "pdf.vatStatement.exempt",
  "exempt:health": "pdf.vatStatement.exempt.health",
  "exempt:education": "pdf.vatStatement.exempt.education",
  // "financial" may be insurance (nr. 10) or finance (nr. 11) and "other" names no provision, so cite the section only.
  "exempt:financial": "pdf.vatStatement.exempt.statute",
  "exempt:other": "pdf.vatStatement.exempt.statute",
  "intra_community:goods": "pdf.vatStatement.intra_community.goods",
  "intra_community:services_b2b": "pdf.vatStatement.intra_community.services_b2b",
  "export:goods_outside_eu": "pdf.vatStatement.export.goods_outside_eu",
  export: "pdf.vatStatement.export.goods_outside_eu",
  // Only drafts reach here without a reason; the issuing checks require one.
  intra_community: "vat.treatment.intra_community",
  // Denmark has no construction reverse charge in momsloven § 46, stk. 1, so no provision is cited for any reason.
  reverse_charge_domestic: "pdf.vatStatement.reverse_charge_domestic",
}

export function vatReasonKeys(row: VatRow): TranslationKey[] {
  const treatments = row.treatments ?? (row.treatment ? [row.treatment] : [])
  const reasons = [...new Set(row.reasonCodes ?? (row.reasonCode ? [row.reasonCode] : []))]
  const keys = treatments.flatMap<TranslationKey>(treatment => {
    if (treatment === "out_of_scope") return ["pdf.vatOutOfScope"]
    const specific = reasons.flatMap(reason => vatStatementKeys[`${treatment}:${reason}`] ?? [])
    const fallback = vatStatementKeys[treatment]
    return specific.length ? specific : fallback ? [fallback] : []
  })
  return [...new Set(keys)]
}

/** The document's nominal rate from its lines in order: the first positive one, else the first. */
export function nominalLineTaxRate(rates: readonly (number | null | undefined)[]): number | undefined {
  const known = rates.filter((rate): rate is number => rate != null)
  return known.find(rate => rate > 0) ?? known[0]
}

export function deviationVatLabel(rate: number | undefined, rows: readonly VatRow[] | null | undefined, mainRate?: number, momsRegistered?: boolean | null): TranslationKey | null {
  const main = mainRate ?? Number(rows?.find(row => Number(row.ratePercent) > 0)?.ratePercent)
  return momsRegistered !== false && rate !== undefined && Number.isFinite(main) && rate !== main ? "pdf.lineVatRate" : null
}
