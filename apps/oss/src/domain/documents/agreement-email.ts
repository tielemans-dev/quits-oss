import type { AgreementOfferSnapshot } from "@quits/contracts/agreements"
import { composeMessage, escapeHtml, sanitizeHeader } from "../../lib/email"
import { sanitizeAgreementHtml } from "../../lib/agreements/markdown"
import { agreementOfferTotals } from "../../lib/agreements/offer-totals"
import { formatCurrency } from "../../lib/i18n/format"
import { translate } from "../../lib/i18n/translate"
import { resolveQuoteEmailContext } from "./quote-email"

export function composeAgreementEmail(input: {
  snapshot: AgreementOfferSnapshot
  number: string | null
  /** The language the agreement was written in, not the organization's current one. */
  locale: string
  settings: Parameters<typeof resolveQuoteEmailContext>[0]
  recipient: string
  url: string
  accepted?: boolean
}) {
  const { envelope } = resolveQuoteEmailContext(input.settings)
  const { locale } = input
  const title = translate(input.accepted ? "agreements.email.offerAcceptedTitle" : "agreements.email.offerTitle", locale)
  const link = translate(input.accepted ? "agreements.email.readAcceptedOffer" : "agreements.email.reviewOffer", locale)
  const snapshot = input.snapshot
  // The same total the agreement page shows, including a v2 offer's payable rounding.
  const total = formatCurrency(Number(agreementOfferTotals(snapshot).gross), snapshot.currency, locale)
  const html = `<h1>${title} ${escapeHtml(input.number ?? "")}</h1><h2>${escapeHtml(snapshot.title)}</h2>
    <p>${escapeHtml(snapshot.summary ?? "")}</p><p>${escapeHtml(total)}</p>
    <p><a href="${escapeHtml(input.url)}">${escapeHtml(link)}</a></p>
    <p><a href="${escapeHtml(input.url)}/pdf">${escapeHtml(translate("agreements.email.downloadPdf", locale))}</a></p>${sanitizeAgreementHtml(snapshot.termsHtml)}`
  return composeMessage(input.recipient, {
    subject: sanitizeHeader(`${title} ${input.number ?? ""}: ${snapshot.title}`),
    html,
    fromAddress: `${sanitizeHeader(envelope.fromName)} <${sanitizeHeader(envelope.fromEmail)}>`,
    replyTo: envelope.replyTo,
  })
}
