import { formatNumber } from "../i18n/format"
import { translate } from "../i18n/translate"

/** Missing regimes preserve historic presentation; explicit non-EU regimes suppress VAT status. */
export function sellerVatPresentationStatus(momsRegistered: boolean | null | undefined, taxRegime?: string | null) {
  return taxRegime == null || taxRegime === "eu_vat" ? momsRegistered : undefined
}

/** Historic documents with no registration snapshot keep their original presentation. */
export function sellerVatLineText(momsRegistered: boolean | null | undefined, taxRate: number | undefined, locale?: string | null): string | null {
  if (momsRegistered === false && taxRate === 0) return translate("line.noVat", locale)
  return momsRegistered != null && taxRate === 25 ? "25 % moms" : null
}

/**
 * The same line note on an app screen, in the interface's language. The document keeps its
 * own wording: PDFs, emails and public pages use `sellerVatLineText`.
 */
export function sellerVatLineLabel(momsRegistered: boolean | null | undefined, taxRate: number | undefined, locale?: string | null): string | null {
  if (momsRegistered != null && taxRate === 25) return translate("invoiceVat.hosted", locale, { rate: formatNumber(taxRate, locale) })
  return sellerVatLineText(momsRegistered, taxRate, locale)
}
