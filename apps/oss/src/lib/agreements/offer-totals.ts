import type { AgreementOfferSnapshot } from "@quits/contracts/agreements"
import { lineAmounts, priceBasis } from "../documents/line-amounts"
import { translate } from "../i18n/translate"

/**
 * The amounts of an offer as the customer is told them, on the page and in the email alike.
 *
 * A v2 offer states its service total itself, with any payable rounding already in `gross`; an
 * older offer has only the flat totals. Reading them in one place keeps the email and the page
 * from showing different totals for the same agreement.
 */
export function agreementOfferTotals(snapshot: AgreementOfferSnapshot) {
  const v2 = "offerFormatVersion" in snapshot ? snapshot : null
  return {
    isV2: v2 !== null,
    net: v2?.serviceTotal.net ?? snapshot.subtotalNet,
    tax: v2?.serviceTotal.tax ?? snapshot.totalTax,
    gross: v2?.serviceTotal.gross ?? snapshot.totalGross,
    /** Only a v2 offer has one, and only worth showing when it is not zero. */
    payableRounding: v2 && Number(v2.serviceTotal.payableRounding) !== 0 ? v2.serviceTotal.payableRounding : null,
  }
}

/**
 * The unit price and amount one line states, on the basis the offer was priced on: net when its
 * prices exclude VAT, so the lines add up to the subtotal, and gross when they include it. Quotes
 * and invoices print their lines the same way.
 */
export function agreementLineAmounts<Amount>(
  offer: { pricesIncludeTax: boolean },
  line: { unitPriceNet: Amount; unitPriceGross: Amount; lineNet: Amount; lineGross: Amount },
) {
  return lineAmounts(priceBasis(offer.pricesIncludeTax), line)
}

/**
 * Which side of VAT an offer's amounts are on, in words, so no amount is left for the reader to
 * guess. Lines follow the offer's price basis; the total always includes the VAT. An offer that
 * carries no VAT states neither, as its subtotal and total do not either.
 */
export function agreementVatBasisLabels(
  offer: { pricesIncludeTax: boolean; isV2: boolean; tax: number | string },
  locale?: string | null,
) {
  const vat = Number(offer.tax) !== 0
  return {
    line: vat ? translate(offer.pricesIncludeTax ? "agreements.vatBasis.gross" : "agreements.vatBasis.net", locale) : null,
    total: translate(offer.isV2
      ? vat ? "agreements.serviceTotalInclVat" : "agreements.serviceTotal"
      : vat ? "agreements.totalInclVat" : "agreements.total", locale),
  }
}
