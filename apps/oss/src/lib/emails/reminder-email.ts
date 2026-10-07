import { actionBlock, escapeHtml, fromAddress, layout, sanitizeHeader, t } from "../email"
import { formatCurrency, formatDate } from "../i18n/format"

export type ReminderEmailParams = {
  to: string
  fromName?: string | null
  fromEmail?: string | null
  replyTo?: string | null
  /** `overdue` once the due date has passed, `upcoming` before it. */
  stage: "upcoming" | "overdue"
  invoice: {
    number: string
    /** Calendar date (UTC midnight). */
    dueDate: Date | string
    currency: string
    balanceDue: number
  }
  org: {
    companyName?: string | null
    companyEmail?: string | null
    locale?: string | null
    timezone?: string | null
  }
  contactName: string
  publicPaymentUrl?: string | null
}

export function buildReminderEmailContent({
  fromName,
  fromEmail,
  replyTo,
  stage,
  invoice,
  org,
  contactName,
  publicPaymentUrl,
}: Omit<ReminderEmailParams, "to">) {
  const locale = org.locale
  const safeFromName = sanitizeHeader(fromName ?? org.companyName ?? "Quits")
  const safeFromEmail = sanitizeHeader(fromEmail ?? fromAddress())
  // Due dates are calendar dates stored as UTC midnight; formatting them in the organization's
  // timezone would show the previous day west of UTC.
  const dueDate = formatDate(invoice.dueDate, locale, "UTC")
  const balance = formatCurrency(invoice.balanceDue, invoice.currency, locale)
  const company = org.companyName ?? safeFromName

  const html = layout(
    `
    <h2 style="margin:0 0 16px;font-size:22px;">${t(`reminders.email.title.${stage}`, locale)}</h2>
    <p style="margin:0 0 8px;">${t("reminders.email.greeting", locale, { name: escapeHtml(contactName) })}</p>
    <p style="margin:0 0 24px;color:#374151;">${t(`reminders.email.body.${stage}`, locale, {
      number: escapeHtml(invoice.number),
      company: escapeHtml(company),
      dueDate,
    })}</p>

    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="padding:6px 0;color:#6b7280;">${t("reminders.email.invoiceNumber", locale)}</td>
        <td style="padding:6px 0;text-align:right;">${escapeHtml(invoice.number)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:#6b7280;">${t("reminders.email.dueDate", locale)}</td>
        <td style="padding:6px 0;text-align:right;">${dueDate}</td>
      </tr>
      <tr style="border-top:2px solid #e5e7eb;">
        <td style="padding:8px 0;font-weight:bold;">${t("reminders.email.balanceDue", locale)}</td>
        <td style="padding:8px 0;text-align:right;font-weight:bold;font-size:18px;">${balance}</td>
      </tr>
    </table>

    ${
      publicPaymentUrl
        ? actionBlock({
            href: publicPaymentUrl,
            label: t("reminders.email.payCta", locale),
            fallbackLabel: t("reminders.email.payFallback", locale),
          })
        : ""
    }
    <p style="margin:24px 0 0;color:#6b7280;font-size:14px;">${t("reminders.email.alreadyPaid", locale)}</p>
    ${
      org.companyEmail
        ? `<p style="margin:8px 0 0;color:#6b7280;font-size:14px;">${t("reminders.email.contact", locale, {
            email: escapeHtml(org.companyEmail),
          })}</p>`
        : ""
    }
  `,
    locale
  )

  const subject = sanitizeHeader(
    t(`reminders.email.subject.${stage}`, locale, { number: invoice.number, dueDate, balance })
  )

  return {
    subject,
    html,
    fromAddress: `${safeFromName} <${safeFromEmail}>`,
    replyTo: replyTo?.trim() || null,
  }
}

