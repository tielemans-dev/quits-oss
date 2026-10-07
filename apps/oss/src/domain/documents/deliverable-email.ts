import { composeMessage, escapeHtml, sanitizeHeader } from "../../lib/email"
import { translate } from "../../lib/i18n/translate"
import { resolveQuoteEmailContext } from "./quote-email"

export function composeDeliverableEmail(input: {
  settings: Parameters<typeof resolveQuoteEmailContext>[0]
  locale: string
  number: string | null
  title: string
  recipient: string
  url: string
  kind: "delivered" | "accepted" | "changes_requested"
  note?: string | null
}) {
  const { envelope } = resolveQuoteEmailContext(input.settings)
  const title = translate(`agreements.email.${input.kind}`, input.locale)
  const link = translate(input.kind === "delivered" ? "agreements.reviewDelivery" : "agreements.readAgreement", input.locale)
  return composeMessage(input.recipient, {
    subject: sanitizeHeader(`${title}: ${input.number ?? ""} ${input.title}`),
    html: `<h1>${escapeHtml(title)}</h1><h2>${escapeHtml(input.title)}</h2>${input.note ? `<p style="white-space:pre-wrap">${escapeHtml(input.note)}</p>` : ""}<p><a href="${escapeHtml(input.url)}">${escapeHtml(link)}</a></p>`,
    fromAddress: `${sanitizeHeader(envelope.fromName)} <${sanitizeHeader(envelope.fromEmail)}>`,
    replyTo: envelope.replyTo,
  })
}
