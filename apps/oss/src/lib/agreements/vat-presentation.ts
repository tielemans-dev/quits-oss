import type { AgreementOfferSnapshot } from "@quits/contracts/agreements"
import { sellerVatLineText, sellerVatPresentationStatus } from "../documents/seller-vat"
import { nonVatStatement } from "../documents/non-vat-note"
import { buildTotals } from "../documents/totals"
import { vatRowsByRate } from "../../domain/documents/frozen-vat-groups"
import { deviationVatLabel } from "../documents/line-amounts"
import { formatNumber } from "../i18n/format"
import { translate } from "../i18n/translate"

/** All offer channels read the frozen registration, regime and line rates. */
export function agreementVatPresentation(snapshot: AgreementOfferSnapshot, locale = snapshot.locale) {
  const status = sellerVatPresentationStatus(snapshot.sellerSnapshot?.momsRegistered, snapshot.taxRegime)
  const statement = status === false ? nonVatStatement(locale) : null
  const v2 = "offerFormatVersion" in snapshot ? snapshot : null
  const rows = v2 ? vatRowsByRate(v2.vatGroups, snapshot.currency) : undefined
  return {
    totals: v2 ? buildTotals({ basis: "net", subtotal: v2.serviceTotal.net, taxAmount: v2.serviceTotal.tax, total: v2.serviceTotal.gross, rounding: v2.serviceTotal.payableRounding, vatRows: rows, currency: snapshot.currency, locale }) : null,
    status,
    taxLabel: translate(status === false ? "line.noVat" : "agreements.tax", locale),
    statement: statement && !`${snapshot.summary ?? ""} ${snapshot.termsHtml}`.includes(statement) ? statement : null,
    lineLabel: (rate: string) => deviationVatLabel(Number(rate), rows, Number(snapshot.taxRate), status) ? translate("pdf.lineVatRate", locale, { rate: formatNumber(Number(rate), locale) }) : sellerVatLineText(status, Number(rate), locale),
    scheduleBasis: (basis: "net" | "gross") => translate(status === false ? "line.noVat" : basis === "gross" ? "agreements.vatBasis.gross" : "agreements.vatBasis.net", locale),
  }
}
