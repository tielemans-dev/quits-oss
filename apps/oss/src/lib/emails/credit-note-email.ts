import { sellerVatPresentationStatus } from "../documents/seller-vat"
import { parseSellerSnapshot } from "@quits/contracts/documents"
import { nonVatStatement } from "../documents/non-vat-note"
import { withoutNonVatStatement } from "../documents/non-vat-presentation"
import { documentColors as C } from "../brand/document-colors"
import { formatSenderAddress } from "../email-sender"
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
import type { PriceBasis, VatRow } from "../documents/line-amounts"

export type SendCreditNoteEmailParams = {
  to: string
  fromName?: string | null
  fromEmail?: string | null
  replyTo?: string | null
  creditNote: {
    number: string
    issueDate: Date | string
    reason: string
    sellerSnapshot?: unknown
    subtotal: number
    taxAmount: number
    total: number
    taxRegime?: string
    currency: string
    /** The basis `items` state their amounts on. Absent, the headers stay plain. */
    priceBasis?: PriceBasis
    vatRows?: VatRow[]
    rounding?: string
    items: { description: string; quantity: number; unitPrice: number; total: number; taxRate?: number }[]
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
  const momsRegistered = sellerVatPresentationStatus(parseSellerSnapshot(creditNote.sellerSnapshot)?.momsRegistered, creditNote.taxRegime)
  const reason = withoutNonVatStatement(creditNote.reason, momsRegistered, creditNote.taxRegime)
  const locale = org.locale
  const timezone = org.timezone
  const label = `font-size:12px;color:${C.muted};text-transform:uppercase;margin-bottom:2px;`

  const html = layout(
    `
    <h2 style="margin:0 0 4px;font-size:22px;">${t("creditNotes.pdf.title", locale)} ${escapeHtml(creditNote.number)}</h2>
    <p style="margin:0 0 24px;color:${C.muted};">${t("creditNotes.email.greeting", locale, {
      name: escapeHtml(contactName),
      invoiceNumber: escapeHtml(invoice.number),
    })}</p>

    <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
      <div>
        <div style="${label}">${t("pdf.from", locale)}</div>
        <div style="font-weight:500;">${escapeHtml(safeFromName)}</div>
        ${safeCompanyEmail ? `<div style="color:${C.muted};font-size:14px;">${safeCompanyEmail}</div>` : ""}
      </div>
      <div style="text-align:right;">
        <div style="${label}">${t("creditNotes.email.reference", locale)}</div>
        <div style="font-weight:500;">${escapeHtml(invoice.number)}</div>
        <div style="color:${C.muted};font-size:14px;">${formatDate(invoice.issueDate, locale, timezone, { month: "long" })}</div>
      </div>
    </div>

    ${itemsTable(creditNote.items, creditNote.currency, locale, creditNote.priceBasis, false, momsRegistered)}
    ${totalsBlock(creditNote, locale)}
    ${momsRegistered === false ? `<p style="margin-top:24px;color:${C.muted};font-size:14px;">${escapeHtml(nonVatStatement(locale))}</p>` : ""}

    <div style="margin-top:24px;border-top:1px solid ${C.hairline};padding-top:16px;">
      <div style="${label}">${t("creditNotes.email.reason", locale)}</div>
      <p style="margin:0;color:${C.body};font-size:14px;">${formatMultilineHtml(reason ?? "")}</p>
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
    fromAddress: formatSenderAddress(safeFromName, safeFromEmail),
    replyTo: replyTo?.trim() || null,
  }
}

