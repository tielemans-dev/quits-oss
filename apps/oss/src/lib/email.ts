import { Resend } from "resend"
import { formatCurrency, formatDate } from "./i18n/format"
import { translate } from "./i18n/translate"
import type { TranslationKey } from "./i18n/messages"
import { lineColumnKeys, type PriceBasis, type VatRow } from "./documents/line-amounts"
import { buildTotals } from "./documents/totals"
import { selectedEmailProvider, readSmtpConfiguration, type EmailProvider, type EmailEnvironment } from "./email-provider-config"
import { assertOperationsLive } from "./operations-hold"
import { getRuntimePlatform, getRuntimeEnv } from "./runtime/platform"

let _resend: Resend | null = null

export function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim()
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

export function escapeAttribute(value: string): string {
  return escapeHtml(value)
}

export function formatMultilineHtml(value: string): string {
  return escapeHtml(value).replaceAll("\n", "<br />")
}

let _resendKey: string | undefined

function getResend(environment: EmailEnvironment = getRuntimeEnv()): Resend {
  const key = environment.RESEND_API_KEY
  if (!key) {
    throw new Error("RESEND_API_KEY is not configured")
  }
  if (!_resend || _resendKey !== key) {
    _resend = new Resend(key)
    _resendKey = key
  }
  return _resend
}

/**
 * Throws if email cannot be sent from this process (e.g. no API key), before any request is made.
 * Lets callers tell a local configuration problem from a request whose outcome is unknown.
 */
export function ensureEmailProvider(provider?: EmailProvider, environment: EmailEnvironment = getRuntimeEnv()) {
  if ((provider ?? selectedEmailProvider(environment.EMAIL_PROVIDER ?? "")) === "resend") {
    getResend(environment)
  } else {
    if (getRuntimePlatform().getRuntimeKind() !== "node") {
      throw new Error("SMTP email delivery requires the Node/Bun runtime")
    }
    readSmtpConfiguration(environment)
  }
}

export class EmailSendError extends Error {
  readonly providerCode: string

  constructor(providerCode: string, message: string) {
    super(message)
    this.name = "EmailSendError"
    this.providerCode = providerCode
  }
}

export type EmailMessage = Parameters<Resend["emails"]["send"]>[0]

/** Rendered email content, as returned by the `build*EmailContent` helpers. */
export type EmailContent = {
  subject: string
  html: string
  fromAddress: string
  replyTo: string | null
}

/** The provider message for rendered content. */
export function composeMessage(to: string, content: EmailContent) {
  return {
    from: content.fromAddress,
    to,
    subject: content.subject,
    html: content.html,
    ...(content.replyTo ? { replyTo: content.replyTo } : {}),
  }
}

export type DeliveryOptions = {
  /** Explicit server environment for auth adapters built with an independent env reader. */
  environment?: EmailEnvironment
  /** Persisted by the outbox before sending; a restart must keep the same provider. */
  provider?: EmailProvider
  /**
   * Resend drops repeats of this key. SMTP does not support idempotency and ignores it.
   */
  idempotencyKey?: string
}

/**
 * Resend reports API failures in the result instead of throwing; they are thrown here as
 * `EmailSendError` so callers can tell a provider answer from a lost request.
 */
export async function deliver(
  message: EmailMessage,
  options: DeliveryOptions = {}
): Promise<{ id: string }> {
  // Every outgoing message passes through here, so a held installation cannot email anyone.
  await assertOperationsLive("sending email")
  const environment = options.environment ?? getRuntimeEnv()
  if ((options.provider ?? selectedEmailProvider(environment.EMAIL_PROVIDER ?? "")) === "smtp") {
    ensureEmailProvider("smtp", environment)
    const { deliverSmtp } = await import("./email-smtp-node")
    return deliverSmtp(message, environment)
  }
  const result = await getResend(environment).emails.send(
    message,
    options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined
  )
  if (result.error) {
    throw new EmailSendError(result.error.name, result.error.message)
  }

  return { id: result.data.id }
}

export function fromAddress(environment: EmailEnvironment = getRuntimeEnv()): string {
  return sanitizeHeader(environment.FROM_EMAIL ?? "noreply@yaip.app")
}

export function t(
  key: TranslationKey,
  locale?: string | null,
  vars?: Record<string, string | number>
) {
  return translate(key, locale, vars)
}

/** Item unit prices and totals are the stored amounts on the document's price basis, named in the headers. */
export function itemsTable(
  items: { description: string; quantity: number; unitPrice: number; total: number }[],
  currency: string,
  locale?: string | null,
  basis?: PriceBasis
) {
  const columns = lineColumnKeys(basis)
  const rows = items.map((item) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;">${escapeHtml(item.description)}</td>
      <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;text-align:right;">${item.quantity}</td>
      <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;text-align:right;">${formatCurrency(item.unitPrice, currency, locale)}</td>
      <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;text-align:right;">${formatCurrency(item.total, currency, locale)}</td>
    </tr>`).join("")

  return `
    <table style="width:100%;border-collapse:collapse;margin:24px 0;">
      <thead>
        <tr style="border-bottom:2px solid #e5e7eb;">
          <th style="padding:8px 0;text-align:left;color:#6b7280;font-size:12px;text-transform:uppercase;">${t("pdf.description", locale)}</th>
          <th style="padding:8px 0;text-align:right;color:#6b7280;font-size:12px;text-transform:uppercase;">${t("pdf.qty", locale)}</th>
          <th style="padding:8px 0;text-align:right;color:#6b7280;font-size:12px;text-transform:uppercase;">${t(columns.unitPrice, locale)}</th>
          <th style="padding:8px 0;text-align:right;color:#6b7280;font-size:12px;text-transform:uppercase;">${t(columns.amount, locale)}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
}

/** The rows under the items, from the same builder as the PDFs and pages: subtotal, VAT by rate, rounding, total. */
export function totalsBlock(
  document: {
    subtotal: number
    taxAmount: number
    total: number
    currency: string
    priceBasis?: PriceBasis
    vatRows?: readonly VatRow[] | null
    rounding?: string | null
  },
  locale?: string | null
) {
  const totals = buildTotals({ basis: document.priceBasis, ...document, locale })
  const money = (amount: string) => formatCurrency(Number(amount), document.currency, locale)
  const row = (label: string, amount: string) => `
      <tr>
        <td style="padding:4px 0;color:#6b7280;">${escapeHtml(label)}</td>
        <td style="padding:4px 0;text-align:right;">${money(amount)}</td>
      </tr>`
  return `
    <table style="width:100%;border-collapse:collapse;margin-top:8px;">${totals.lines.map((line) => row(line.label, line.amount)).join("")}
      <tr style="border-top:2px solid #e5e7eb;">
        <td style="padding:8px 0;font-weight:bold;">${escapeHtml(totals.total.label)}</td>
        <td style="padding:8px 0;text-align:right;font-weight:bold;font-size:18px;">${money(totals.total.amount)}</td>
      </tr>
    </table>`
}

export function layout(content: string, locale?: string | null) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:#111827;padding:24px 32px;">
      <span style="color:#fff;font-size:20px;font-weight:bold;">Quits</span>
    </div>
    <div style="padding:32px;">
      ${content}
    </div>
    <div style="padding:16px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;text-align:center;">
      ${t("email.footer.sentVia", locale)}
    </div>
  </div>
</body>
</html>`
}

export function actionBlock(input: {
  href: string
  label: string
  fallbackLabel: string
}) {
  const safeHref = escapeAttribute(input.href)
  return `
    <div style="margin-top:24px;padding-top:24px;border-top:1px solid #e5e7eb;">
      <a href="${safeHref}"
         style="display:inline-block;background:#111827;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:500;">
        ${escapeHtml(input.label)}
      </a>
      <p style="margin:16px 0 0;color:#6b7280;font-size:14px;">${escapeHtml(input.fallbackLabel)}</p>
      <p style="margin:8px 0 0;font-size:14px;word-break:break-all;">
        <a href="${safeHref}" style="color:#111827;">${escapeHtml(input.href)}</a>
      </p>
    </div>`
}

// ── Invoice email ──────────────────────────────────────────────────

export type SendInvoiceEmailParams = {
  to: string
  fromName?: string | null
  fromEmail?: string | null
  replyTo?: string | null
  invoice: {
    number: string
    issueDate: Date | string
    dueDate: Date | string
    subtotal: number
    taxAmount: number
    total: number
    currency: string
    notes?: string | null
    /** The basis `items` state their amounts on. Absent, the headers stay plain. */
    priceBasis?: PriceBasis
    /** VAT by rate and the rounding between net plus tax and the total; absent, the single tax amount is printed. */
    vatRows?: VatRow[]
    rounding?: string
    items: { description: string; quantity: number; unitPrice: number; total: number }[]
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

export function buildInvoiceEmailContent({
  fromName,
  fromEmail,
  replyTo,
  invoice,
  org,
  contactName,
  publicPaymentUrl,
}: Omit<SendInvoiceEmailParams, "to">) {
  const safeFromName = sanitizeHeader(fromName ?? org.companyName ?? "Quits")
  const safeFromEmail = sanitizeHeader(fromEmail ?? fromAddress())
  const safeInvoiceNumber = escapeHtml(invoice.number)
  const safeContactName = escapeHtml(contactName)
  const safeCompanyEmail = org.companyEmail ? escapeHtml(org.companyEmail) : null
  const locale = org.locale
  const timezone = org.timezone
  const html = layout(`
    <h2 style="margin:0 0 4px;font-size:22px;">${t("pdf.invoice", locale)} ${safeInvoiceNumber}</h2>
    <p style="margin:0 0 24px;color:#6b7280;">${t("email.invoice.greeting", locale, { name: safeContactName })}</p>

    <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
      <div>
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;margin-bottom:2px;">${t("pdf.from", locale)}</div>
        <div style="font-weight:500;">${escapeHtml(safeFromName)}</div>
        ${safeCompanyEmail ? `<div style="color:#6b7280;font-size:14px;">${safeCompanyEmail}</div>` : ""}
      </div>
      <div style="text-align:right;">
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;margin-bottom:2px;">${t("pdf.dueDate", locale)}</div>
        <div style="font-weight:500;">${formatDate(invoice.dueDate, locale, timezone)}</div>
      </div>
    </div>

    ${itemsTable(invoice.items, invoice.currency, locale, invoice.priceBasis)}
    ${totalsBlock(invoice, locale)}

    ${invoice.notes ? `<p style="margin-top:24px;color:#6b7280;font-size:14px;border-top:1px solid #e5e7eb;padding-top:16px;">${formatMultilineHtml(invoice.notes)}</p>` : ""}
    ${publicPaymentUrl
      ? actionBlock({
          href: publicPaymentUrl,
          label: t("email.invoice.payCta", locale),
          fallbackLabel: t("email.invoice.payFallback", locale),
        })
      : ""}
  `, locale)

  const subject = sanitizeHeader(
    t("email.invoice.subject", locale, {
      number: invoice.number,
      total: formatCurrency(invoice.total, invoice.currency, locale),
      dueDate: formatDate(invoice.dueDate, locale, timezone),
    })
  )
  const fromAddressValue = `${safeFromName} <${safeFromEmail}>`

  return {
    subject,
    html,
    fromAddress: fromAddressValue,
    replyTo: replyTo?.trim() || null,
  }
}

// ── Quote email ────────────────────────────────────────────────────

export type SendQuoteEmailParams = {
  to: string
  fromName?: string | null
  fromEmail?: string | null
  replyTo?: string | null
  quote: {
    number: string
    issueDate: Date | string
    expiryDate: Date | string
    subtotal: number
    taxAmount: number
    total: number
    currency: string
    notes?: string | null
    /** The basis `items` state their amounts on. Absent, the headers stay plain. */
    priceBasis?: PriceBasis
    /** VAT by rate and the rounding between net plus tax and the total; absent, the single tax amount is printed. */
    vatRows?: VatRow[]
    rounding?: string
    items: { description: string; quantity: number; unitPrice: number; total: number }[]
  }
  org: {
    companyName?: string | null
    companyEmail?: string | null
    locale?: string | null
    timezone?: string | null
  }
  contactName: string
  publicQuoteUrl?: string | null
}

export function buildQuoteEmailContent({
  fromName,
  fromEmail,
  replyTo,
  quote,
  org,
  contactName,
  publicQuoteUrl,
}: Omit<SendQuoteEmailParams, "to">) {
  const safeFromName = sanitizeHeader(fromName ?? org.companyName ?? "Quits")
  const safeFromEmail = sanitizeHeader(fromEmail ?? fromAddress())
  const safeQuoteNumber = escapeHtml(quote.number)
  const safeContactName = escapeHtml(contactName)
  const safeCompanyEmail = org.companyEmail ? escapeHtml(org.companyEmail) : null
  const locale = org.locale
  const timezone = org.timezone
  const html = layout(`
    <h2 style="margin:0 0 4px;font-size:22px;">${t("email.quote.title", locale)} ${safeQuoteNumber}</h2>
    <p style="margin:0 0 24px;color:#6b7280;">${t("email.quote.greeting", locale, { name: safeContactName })}</p>

    <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
      <div>
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;margin-bottom:2px;">${t("pdf.from", locale)}</div>
        <div style="font-weight:500;">${escapeHtml(safeFromName)}</div>
        ${safeCompanyEmail ? `<div style="color:#6b7280;font-size:14px;">${safeCompanyEmail}</div>` : ""}
      </div>
      <div style="text-align:right;">
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;margin-bottom:2px;">${t("email.quote.validUntil", locale)}</div>
        <div style="font-weight:500;">${formatDate(quote.expiryDate, locale, timezone)}</div>
      </div>
    </div>

    ${itemsTable(quote.items, quote.currency, locale, quote.priceBasis)}
    ${totalsBlock(quote, locale)}

    ${quote.notes ? `<p style="margin-top:24px;color:#6b7280;font-size:14px;border-top:1px solid #e5e7eb;padding-top:16px;">${formatMultilineHtml(quote.notes)}</p>` : ""}
    ${publicQuoteUrl
      ? actionBlock({
          href: publicQuoteUrl,
          label: t("email.quote.reviewCta", locale),
          fallbackLabel: t("email.quote.reviewFallback", locale),
        })
      : ""}
  `, locale)

  const subject = sanitizeHeader(
    t("email.quote.subject", locale, {
      number: quote.number,
      total: formatCurrency(quote.total, quote.currency, locale),
      expiryDate: formatDate(quote.expiryDate, locale, timezone),
    })
  )
  const fromAddressValue = `${safeFromName} <${safeFromEmail}>`

  return {
    subject,
    html,
    fromAddress: fromAddressValue,
    replyTo: replyTo?.trim() || null,
  }
}

// ── Invitation email ───────────────────────────────────────────────

type SendInvitationEmailParams = {
  to: string
  inviterName: string
  orgName: string
  invitationUrl: string
  locale?: string | null
}

export function buildInvitationEmailContent({
  inviterName,
  orgName,
  invitationUrl,
  locale,
}: Omit<SendInvitationEmailParams, "to">, environment: EmailEnvironment = getRuntimeEnv()) {
  const safeInviterName = escapeHtml(inviterName)
  const safeOrgName = escapeHtml(orgName)
  const safeInvitationUrl = escapeAttribute(invitationUrl)
  const html = layout(`
    <h2 style="margin:0 0 8px;font-size:22px;">${t("email.invitation.title", locale, { orgName: safeOrgName })}</h2>
    <p style="color:#6b7280;margin-bottom:32px;">${t("email.invitation.body", locale, { inviterName: safeInviterName })}</p>
    <a href="${safeInvitationUrl}"
       style="display:inline-block;background:#111827;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:500;">
      ${t("email.invitation.accept", locale)}
    </a>
    <p style="margin-top:24px;font-size:12px;color:#9ca3af;">
      ${t("email.invitation.expiry", locale)}
    </p>
  `, locale)

  return {
    subject: sanitizeHeader(
      t("email.invitation.subject", locale, { inviterName, orgName })
    ),
    html,
    fromAddress: `Quits <${fromAddress(environment)}>`,
  }
}

export async function sendInvitationEmail({
  to,
  inviterName,
  orgName,
  invitationUrl,
  locale,
}: SendInvitationEmailParams, options: DeliveryOptions = {}) {
  const content = buildInvitationEmailContent({
    inviterName,
    orgName,
    invitationUrl,
    locale,
  }, options.environment)

  return deliver({
    from: content.fromAddress,
    to,
    subject: content.subject,
    html: content.html,
  }, options)
}
