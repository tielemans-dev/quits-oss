import { formatNumber } from "../i18n/format"
import { translate } from "../i18n/translate"

/** Missing regimes preserve historic presentation; explicit non-EU regimes suppress VAT status. */
export function sellerVatPresentationStatus(momsRegistered: boolean | null | undefined, taxRegime?: string | null) {
  return taxRegime == null || taxRegime === "eu_vat" ? momsRegistered : undefined
}

/** Historic documents with no registration snapshot keep their original presentation. */
export function sellerVatLineText(momsRegistered: boolean | null | undefined, taxRate: number | undefined, locale?: string | null): string | null {
  if (momsRegistered === false && taxRate === 0) return translate("line.noVat", locale)
  return momsRegistered != null && taxRate === 25 ? translate("invoiceVat.hosted", locale, { rate: formatNumber(taxRate, locale) }) : null
}

/**
 * @deprecated App screens and documents now share one wording; use `sellerVatLineText`. Kept so
 * code written against earlier releases, such as CI's baseline screenshot pages, still loads.
 */
export const sellerVatLineLabel = sellerVatLineText
