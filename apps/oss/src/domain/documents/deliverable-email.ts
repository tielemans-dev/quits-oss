import { actionBlock, composeMessage, escapeHtml, layout, sanitizeHeader } from "../../lib/email"
import { documentColors as C } from "../../lib/brand/document-colors"
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
    html: layout(`
      <h2 style="margin:0 0 4px;font-size:22px;">${escapeHtml(title)}</h2>
      <p style="margin:0 0 16px;font-size:18px;font-weight:600;">${escapeHtml(input.title)}</p>
      ${input.note ? `<p style="margin:0 0 16px;color:${C.body};white-space:pre-wrap;">${escapeHtml(input.note)}</p>` : ""}
      ${actionBlock({ href: input.url, label: link, fallbackLabel: translate("agreements.email.linkFallback", input.locale) })}
    `, input.locale),
    fromAddress: `${sanitizeHeader(envelope.fromName)} <${sanitizeHeader(envelope.fromEmail)}>`,
    replyTo: envelope.replyTo,
  })
}
