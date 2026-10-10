import { documentColors as C } from "../brand/document-colors"
import { PAYMENT_DETAILS_FIELDS } from "@quits/contracts/payment-details"
import { composeMessage, deliver, escapeHtml, fromAddress, layout, sanitizeHeader, t } from "../email"
import type { DeliveryOptions } from "../email"
import { normalizeLocale, normalizeTimeZone } from "../i18n/locale"
import { PAYMENT_DETAIL_LABEL_KEYS, type PaymentDetailsChange } from "../payment-details-audit"

export type PaymentDetailsChangedEmailInput = {
  to: string
  /** Who changed the details, already formatted: "Name <email>" for a person (see `formatChangedBy`). */
  changedBy: string
  changedAt: Date | string
  /** The masked changes, as recorded in the audit log. */
  changes: readonly PaymentDetailsChange[]
  organizationName: string
  /** The organization's locale and time zone, as for every other email it causes. */
  locale?: string | null
  timezone?: string | null
  fromEmail?: string
}

function formatDateTime(value: Date | string, locale?: string | null, timeZone?: string | null) {
  return new Intl.DateTimeFormat(normalizeLocale(locale), {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: normalizeTimeZone(timeZone),
  }).format(new Date(value))
}

export function buildPaymentDetailsChangedEmailContent({
  changedBy,
  changedAt,
  changes,
  organizationName,
  locale,
  timezone,
  fromEmail,
}: Omit<PaymentDetailsChangedEmailInput, "to">) {
  const ordered = [...changes].sort(
    (a, b) => PAYMENT_DETAILS_FIELDS.indexOf(a.field) - PAYMENT_DETAILS_FIELDS.indexOf(b.field)
  )
  const cell = `padding:8px 8px 8px 0;border-bottom:1px solid ${C.hairline};vertical-align:top;`
  const head = `padding:8px 8px 8px 0;border-bottom:2px solid ${C.hairline};text-align:left;color:${C.muted};font-size:12px;text-transform:uppercase;`
  const value = (text: string | null) => escapeHtml(text ?? t("email.paymentDetailsChanged.none", locale))
  const rows = ordered
    .map(
      (change) => `
      <tr>
        <td style="${cell}color:${C.muted};">${escapeHtml(t(PAYMENT_DETAIL_LABEL_KEYS[change.field], locale))}</td>
        <td style="${cell}font-family:ui-monospace,monospace;">${value(change.before)}</td>
        <td style="${cell}font-family:ui-monospace,monospace;font-weight:600;">${value(change.after)}</td>
      </tr>`
    )
    .join("")

  return {
    subject: sanitizeHeader(t("email.paymentDetailsChanged.subject", locale)),
    html: layout(
      `
      <h2 style="margin:0 0 8px;font-size:22px;">${escapeHtml(t("email.paymentDetailsChanged.title", locale))}</h2>
      <p style="margin:0 0 16px;color:${C.body};">${escapeHtml(t("email.paymentDetailsChanged.intro", locale, { name: changedBy }))}</p>
      <p style="margin:0 0 4px;color:${C.muted};">${escapeHtml(t("email.paymentDetailsChanged.organization", locale))}: <span style="color:${C.ink};">${escapeHtml(organizationName)}</span></p>
      <p style="margin:0 0 16px;color:${C.muted};">${escapeHtml(t("email.paymentDetailsChanged.changedAt", locale))}: <span style="color:${C.ink};">${escapeHtml(formatDateTime(changedAt, locale, timezone))}</span></p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <thead>
          <tr>
            <th style="${head}">${escapeHtml(t("email.paymentDetailsChanged.field", locale))}</th>
            <th style="${head}">${escapeHtml(t("email.paymentDetailsChanged.before", locale))}</th>
            <th style="${head}">${escapeHtml(t("email.paymentDetailsChanged.after", locale))}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin:24px 0 0;padding:12px 16px;background:${C.tones.danger.tint};border-radius:8px;color:${C.tones.danger.text};font-weight:500;">${escapeHtml(t("email.paymentDetailsChanged.warning", locale))}</p>
      <p style="margin-top:16px;font-size:13px;color:${C.muted};">${escapeHtml(t("email.paymentDetailsChanged.sentBecause", locale, { organization: organizationName }))}</p>
    `,
      locale
    ),
    fromAddress: `Quits <${sanitizeHeader(fromEmail?.trim() || fromAddress())}>`,
    replyTo: null,
  }
}

export async function sendPaymentDetailsChangedEmail(
  { to, ...input }: PaymentDetailsChangedEmailInput,
  options: DeliveryOptions = {}
) {
  const fromEmail = input.fromEmail?.trim() || fromAddress(options.environment)
  return deliver(composeMessage(to, buildPaymentDetailsChangedEmailContent({ ...input, fromEmail })), options)
}
