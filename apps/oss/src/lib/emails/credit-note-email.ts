import {
  escapeHtml,
  formatMultilineHtml,
  fromAddress,
  itemsTable,
  layout,
  sanitizeHeader,
  t,
  totalsBlock,
} from "../email"
import { formatCurrency, formatDate } from "../i18n/format"

export type SendCreditNoteEmailParams = {
  to: string
  fromName?: string | null
  fromEmail?: string | null
  replyTo?: string | null
  creditNote: {
    number: string
    issueDate: Date | string
    reason: string
    subtotal: number
    taxAmount: number
    total: number
    currency: string
    items: { description: string; quantity: number; unitPrice: number; total: number }[]
  }
  invoice: { number: string; issueDate: Date | string }
  org: {
    companyName?: string | null
    companyEmail?: string | null
    locale?: string | null
    timezone?: string | null
  }
  contactName: string
}

export function buildCreditNoteEmailContent({
  fromName,
  fromEmail,
  replyTo,
  creditNote,
  invoice,
  org,
  contactName,
}: Omit<SendCreditNoteEmailParams, "to">) {
  const safeFromName = sanitizeHeader(fromName ?? org.companyName ?? "Quits")
  const safeFromEmail = sanitizeHeader(fromEmail ?? fromAddress())
  const safeCompanyEmail = org.companyEmail ? escapeHtml(org.companyEmail) : null
  const locale = org.locale
  const timezone = org.timezone
  const label = "font-size:12px;color:#6b7280;text-transform:uppercase;margin-bottom:2px;"

  const html = layout(
    `
    <h2 style="margin:0 0 4px;font-size:22px;">${t("creditNotes.pdf.title", locale)} ${escapeHtml(creditNote.number)}</h2>
    <p style="margin:0 0 24px;color:#6b7280;">${t("creditNotes.email.greeting", locale, {
      name: escapeHtml(contactName),
      invoiceNumber: escapeHtml(invoice.number),
    })}</p>

    <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
      <div>
        <div style="${label}">${t("pdf.from", locale)}</div>
        <div style="font-weight:500;">${escapeHtml(safeFromName)}</div>
        ${safeCompanyEmail ? `<div style="color:#6b7280;font-size:14px;">${safeCompanyEmail}</div>` : ""}
      </div>
      <div style="text-align:right;">
        <div style="${label}">${t("creditNotes.email.reference", locale)}</div>
        <div style="font-weight:500;">${escapeHtml(invoice.number)}</div>
        <div style="color:#6b7280;font-size:14px;">${formatDate(invoice.issueDate, locale, timezone)}</div>
      </div>
    </div>

    ${itemsTable(creditNote.items, creditNote.currency, locale)}
    ${totalsBlock(creditNote.subtotal, creditNote.taxAmount, creditNote.total, creditNote.currency, locale)}

    <div style="margin-top:24px;border-top:1px solid #e5e7eb;padding-top:16px;">
      <div style="${label}">${t("creditNotes.email.reason", locale)}</div>
      <p style="margin:0;color:#374151;font-size:14px;">${formatMultilineHtml(creditNote.reason)}</p>
    </div>
  `,
    locale
  )

  const subject = sanitizeHeader(
    t("creditNotes.email.subject", locale, {
      number: creditNote.number,
      invoiceNumber: invoice.number,
      total: formatCurrency(creditNote.total, creditNote.currency, locale),
    })
  )

  return {
    subject,
    html,
    fromAddress: `${safeFromName} <${safeFromEmail}>`,
    replyTo: replyTo?.trim() || null,
  }
}

