import { translate } from "../i18n/translate"

/** Historic documents with no registration snapshot keep their original presentation. */
export function sellerVatLineText(momsRegistered: boolean | null | undefined, taxRate: number | undefined, locale?: string | null): string | null {
  if (momsRegistered === false && taxRate === 0) return translate("line.noVat", locale)
  return momsRegistered != null && taxRate === 25 ? "25 % moms" : null
}
