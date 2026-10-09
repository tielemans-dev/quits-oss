import type { AgreementOfferSnapshot } from "@quits/contracts/agreements"
import { actionBlock, composeMessage, escapeHtml, layout, sanitizeHeader } from "../../lib/email"
import { documentColors as C } from "../../lib/brand/document-colors"
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
  const totals = agreementOfferTotals(snapshot)
  const total = formatCurrency(Number(totals.gross), snapshot.currency, locale)
  const totalLabel = translate(totals.isV2 ? "agreements.serviceTotal" : "agreements.total", locale)
  const html = layout(`
    <h2 style="margin:0 0 4px;font-size:22px;">${escapeHtml(title)} ${escapeHtml(input.number ?? "")}</h2>
    <p style="margin:0 0 16px;font-size:18px;font-weight:600;">${escapeHtml(snapshot.title)}</p>
    ${snapshot.summary ? `<p style="margin:0 0 16px;color:${C.body};white-space:pre-wrap;">${escapeHtml(snapshot.summary)}</p>` : ""}
    <table style="width:100%;border-collapse:collapse;margin:16px 0 0;">
      <tr style="border-top:1px solid ${C.hairline};">
        <td style="padding:8px 0;font-weight:bold;">${escapeHtml(totalLabel)}</td>
        <td style="padding:8px 0;text-align:right;font-weight:bold;font-size:18px;">${escapeHtml(total)}</td>
      </tr>
    </table>
    ${actionBlock({ href: input.url, label: link, fallbackLabel: translate("agreements.email.linkFallback", locale) })}
    <p style="margin:16px 0 0;font-size:14px;"><a href="${escapeHtml(input.url)}/pdf" style="color:${C.ink};">${escapeHtml(translate("agreements.email.downloadPdf", locale))}</a></p>
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid ${C.hairline};color:${C.body};font-size:14px;">${sanitizeAgreementHtml(snapshot.termsHtml)}</div>
  `, locale)
  return composeMessage(input.recipient, {
    subject: sanitizeHeader(`${title} ${input.number ?? ""}: ${snapshot.title}`),
    html,
    fromAddress: `${sanitizeHeader(envelope.fromName)} <${sanitizeHeader(envelope.fromEmail)}>`,
    replyTo: envelope.replyTo,
  })
}
