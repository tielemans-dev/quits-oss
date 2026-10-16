import { documentColors as C } from "../brand/document-colors"
import { formatSenderAddress } from "../email-sender"
import { escapeHtml, fromAddress, layout, sanitizeHeader, t } from "../email"
import { formatCurrency, formatDate } from "../i18n/format"

export type PaymentReceivedEmailParams = {
  /** `client` confirms the payment to the invoice recipient; `seller` tells the seller it arrived. */
  audience: "client" | "seller"
  fromName?: string | null
  fromEmail?: string | null
  replyTo?: string | null
  invoice: { number: string }
  /** The payment as stored: amount in major units, the invoice currency, and when it was received. */
  payment: { amount: number; currency: string; paidAt: Date | string }
  /** The seller's name as the customer knows it. */
  sellerName: string
  contactName: string
  /** Shown to the customer as the place to ask questions. */
  sellerEmail?: string | null
  org: { locale?: string | null; timezone?: string | null }
}

export function buildPaymentReceivedEmailContent({
  audience,
  fromName,
  fromEmail,
  replyTo,
  invoice,
  payment,
  sellerName,
  contactName,
  sellerEmail,
  org,
}: PaymentReceivedEmailParams) {
  const locale = org.locale
  const amount = formatCurrency(payment.amount, payment.currency, locale)
  const paidOn = formatDate(payment.paidAt, locale, org.timezone, { month: "long" })
  const vars = { number: escapeHtml(invoice.number), company: escapeHtml(sellerName), customer: escapeHtml(contactName) }

  const row = (label: string, value: string, strong = false) => `
      <tr${strong ? ` style="border-top:2px solid ${C.hairline};"` : ""}>
        <td style="padding:${strong ? 8 : 6}px 0;color:${strong ? "inherit" : C.muted};${strong ? "font-weight:bold;" : ""}">${label}</td>
        <td style="padding:${strong ? 8 : 6}px 0;text-align:right;${strong ? "font-weight:bold;font-size:18px;" : ""}">${value}</td>
      </tr>`

  const html = layout(
    `
    <h2 style="margin:0 0 16px;font-size:24px;">${t(`payments.email.${audience}.title`, locale)}</h2>
    ${audience === "client" ? `<p style="margin:0 0 8px;">${t("payments.email.client.greeting", locale, { name: escapeHtml(contactName) })}</p>` : ""}
    <p style="margin:0 0 24px;color:${C.body};">${t(`payments.email.${audience}.body`, locale, vars)}</p>

    <table style="width:100%;border-collapse:collapse;">
      ${row(t("payments.email.invoice", locale), escapeHtml(invoice.number))}
      ${audience === "seller" ? row(t("payments.email.customer", locale), escapeHtml(contactName)) : ""}
      ${row(t("payments.email.paidOn", locale), paidOn)}
      ${row(t("payments.email.amount", locale), amount, true)}
    </table>
    ${
      audience === "client" && sellerEmail
        ? `<p style="margin:24px 0 0;color:${C.muted};font-size:14px;">${t("payments.email.contact", locale, { email: escapeHtml(sellerEmail) })}</p>`
        : ""
    }
  `,
    locale
  )

  const safeFromName = sanitizeHeader(fromName ?? sellerName)
  const safeFromEmail = sanitizeHeader(fromEmail ?? fromAddress())
  return {
    subject: sanitizeHeader(t(`payments.email.${audience}.subject`, locale, { number: invoice.number, customer: contactName })),
    html,
    fromAddress: formatSenderAddress(safeFromName, safeFromEmail),
    replyTo: replyTo?.trim() || null,
  }
}
