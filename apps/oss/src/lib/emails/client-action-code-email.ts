import { composeMessage, deliver, escapeHtml, fromAddress, layout, sanitizeHeader, t } from "../email"
import type { DeliveryOptions } from "../email"

export const CLIENT_ACTION_CODE_MINUTES = 10

export type ClientActionCodeEmailInput = {
  to: string
  code: string
  recipientName: string
  sellerName: string | null
  locale?: string | null
}

export function buildClientActionCodeEmailContent(
  { code, recipientName, sellerName, locale }: Omit<ClientActionCodeEmailInput, "to">,
  fromEmail: string,
) {
  const seller = sellerName?.trim() || t("email.clientCode.sellerFallback", locale)
  return {
    subject: sanitizeHeader(t("email.clientCode.subject", locale, { seller })),
    html: layout(
      `
      <h2 style="margin:0 0 8px;font-size:22px;">${escapeHtml(t("email.clientCode.title", locale))}</h2>
      <p style="color:#6b7280;">${escapeHtml(t("email.clientCode.greeting", locale, { name: recipientName }))}</p>
      <p style="color:#6b7280;">${escapeHtml(t("email.clientCode.body", locale, { seller, minutes: CLIENT_ACTION_CODE_MINUTES }))}</p>
      <p style="margin:24px 0;font-size:32px;font-weight:bold;letter-spacing:6px;">${escapeHtml(code)}</p>
      <p style="font-size:14px;color:#6b7280;">${escapeHtml(t("email.clientCode.ignore", locale))}</p>
    `,
      locale,
    ),
    fromAddress: `${sanitizeHeader(seller)} <${sanitizeHeader(fromEmail)}>`,
    replyTo: null,
  }
}

export async function sendClientActionCodeEmail({ to, ...input }: ClientActionCodeEmailInput, options: DeliveryOptions = {}) {
  const content = buildClientActionCodeEmailContent(input, fromAddress(options.environment))
  return deliver(composeMessage(to, content), options)
}
