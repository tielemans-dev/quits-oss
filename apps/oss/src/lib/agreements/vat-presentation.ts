import type { AgreementOfferSnapshot } from "@quits/contracts/agreements"
import { sellerVatLineText, sellerVatPresentationStatus } from "../documents/seller-vat"
import { nonVatStatement } from "../documents/non-vat-note"
import { translate } from "../i18n/translate"

/** All offer channels read the frozen registration, regime and line rates. */
export function agreementVatPresentation(snapshot: AgreementOfferSnapshot, locale = snapshot.locale) {
  const status = sellerVatPresentationStatus(snapshot.sellerSnapshot?.momsRegistered, snapshot.taxRegime)
  const statement = status === false ? nonVatStatement(locale) : null
  return {
    status,
    taxLabel: translate(status === false ? "line.noVat" : "agreements.tax", locale),
    statement: statement && !`${snapshot.summary ?? ""} ${snapshot.termsHtml}`.includes(statement) ? statement : null,
    lineLabel: (rate: string) => sellerVatLineText(status, Number(rate), locale),
    scheduleBasis: (basis: "net" | "gross") => translate(status === false ? "line.noVat" : basis === "gross" ? "agreements.vatBasis.gross" : "agreements.vatBasis.net", locale),
  }
}
