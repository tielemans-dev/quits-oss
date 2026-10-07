import type { AgreementOfferSnapshot } from "@quits/contracts/agreements"
import { composeMessage, escapeHtml, sanitizeHeader } from "../../lib/email"
import { sanitizeAgreementHtml } from "../../lib/agreements/markdown"
import { resolveQuoteEmailContext } from "./quote-email"

export function composeAgreementEmail(input: {
  snapshot: AgreementOfferSnapshot
  number: string | null
  settings: Parameters<typeof resolveQuoteEmailContext>[0]
  recipient: string
  url: string
  accepted?: boolean
}) {
  const { envelope } = resolveQuoteEmailContext(input.settings)
  const title = input.accepted ? "Agreement accepted" : "Agreement"
  const snapshot = input.snapshot
  const html = `<h1>${title} ${escapeHtml(input.number ?? "")}</h1><h2>${escapeHtml(snapshot.title)}</h2>
    <p>${escapeHtml(snapshot.summary ?? "")}</p><p>${escapeHtml(snapshot.totalGross)} ${escapeHtml(snapshot.currency)}</p>
    <p><a href="${escapeHtml(input.url)}">${input.accepted ? "Read accepted agreement" : "Review agreement"}</a></p>
    <p><a href="${escapeHtml(input.url)}/pdf">Download PDF</a></p>${sanitizeAgreementHtml(snapshot.termsHtml)}`
  return composeMessage(input.recipient, {
    subject: sanitizeHeader(`${title} ${input.number ?? ""}: ${snapshot.title}`),
    html,
    fromAddress: `${sanitizeHeader(envelope.fromName)} <${sanitizeHeader(envelope.fromEmail)}>`,
    replyTo: envelope.replyTo,
  })
}
