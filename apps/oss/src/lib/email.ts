import { documentColors as C, EMAIL_FONT_STACK } from "./brand/document-colors"
import { invoicePaymentReferenceHint, invoicePaymentRows } from "./documents/invoice-payment-rows"
import { buyerAddress, invoiceTaxIds } from "./documents/invoice-identity"
import { hasPaymentDetails, type BankAccountSnapshot } from "@quits/contracts/payment-details"
import type { BuyerSnapshot, DocumentTaxId } from "@quits/contracts/documents"
import { Resend } from "resend"
import { formatCurrency, formatDate } from "./i18n/format"
import { translate } from "./i18n/translate"
import type { TranslationKey } from "./i18n/messages"
import { lineColumnKeys, type PriceBasis, type VatRow } from "./documents/line-amounts"
import { buildTotals } from "./documents/totals"
import { selectedEmailProvider, readSmtpConfiguration, type EmailProvider, type EmailEnvironment } from "./email-provider-config"
import { getRuntimePlatform, getRuntimeEnv } from "./runtime/platform"
import { formatSenderAddress } from "./email-sender"

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
  basis?: PriceBasis,
  mobileCards = false
) {
  const columns = lineColumnKeys(basis)
  const rows = items.map((item) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid ${C.hairline};">${escapeHtml(item.description)}</td>
      <td data-label="${t("pdf.qty", locale)}" style="padding:8px 0;border-bottom:1px solid ${C.hairline};text-align:right;">${item.quantity}</td>
      <td data-label="${t(columns.unitPrice, locale)}" style="padding:8px 0;border-bottom:1px solid ${C.hairline};text-align:right;">${formatCurrency(item.unitPrice, currency, locale)}</td>
      <td data-label="${t(columns.amount, locale)}" style="padding:8px 0;border-bottom:1px solid ${C.hairline};text-align:right;">${formatCurrency(item.total, currency, locale)}</td>
    </tr>`).join("")

  return `
    <table class="${mobileCards ? "invoice-items" : ""}" style="width:100%;border-collapse:collapse;margin:24px 0;">
      <thead>
        <tr style="border-bottom:2px solid ${C.hairline};">
          <th style="padding:8px 0;text-align:left;color:${C.muted};font-size:12px;text-transform:uppercase;">${t("pdf.description", locale)}</th>
          <th style="padding:8px 0;text-align:right;color:${C.muted};font-size:12px;text-transform:uppercase;">${t("pdf.qty", locale)}</th>
          <th style="padding:8px 0;text-align:right;color:${C.muted};font-size:12px;text-transform:uppercase;">${t(columns.unitPrice, locale)}</th>
          <th style="padding:8px 0;text-align:right;color:${C.muted};font-size:12px;text-transform:uppercase;">${t(columns.amount, locale)}</th>
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
        <td style="padding:4px 0;color:${C.muted};">${escapeHtml(label)}</td>
        <td style="padding:4px 0;text-align:right;">${money(amount)}</td>
      </tr>`
  return `
    <table style="width:100%;border-collapse:collapse;margin-top:8px;">${totals.lines.map((line) => row(line.label, line.amount)).join("")}
      <tr style="border-top:2px solid ${C.hairline};">
        <td style="padding:8px 0;font-weight:bold;">${escapeHtml(totals.total.label)}</td>
        <td style="padding:8px 0;text-align:right;font-weight:bold;font-size:18px;">${money(totals.total.amount)}</td>
      </tr>
    </table>`
}

/** The quits. wordmark as text: images are often blocked in mail clients. The stop is Settled green. */
export function emailWordmark() {
  return `<span style="font-size:22px;font-weight:600;letter-spacing:-0.03em;line-height:1;color:${C.ink};">quits<span style="color:${C.settled};">.</span></span>`
}

/** The button every email uses for its one action: ink, like the app's primary button. */
export function emailButtonStyle() {
  return `display:inline-block;background:${C.ink};color:${C.paper};padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;`
}

export function layout(content: string, locale?: string | null, invoicePresentation = false) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${invoicePresentation ? `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<style>
  @media (max-width:480px) {
    .email-panel { margin:16px auto !important; }
    .email-content, .email-brand { padding:24px !important; }
    .invoice-parties { display:block !important; }
    .invoice-dates { margin-top:20px; text-align:left !important; }
    .invoice-items thead { display:none; }
    .invoice-items, .invoice-items tbody, .invoice-items tr, .invoice-items td { display:block; width:100%; box-sizing:border-box; }
    .invoice-items tr { margin-bottom:16px; }
    .invoice-items td[data-label]::before { content:attr(data-label); float:left; font-size:12px; color:${C.muted}; }
  }
  @media (prefers-color-scheme:dark) {
    body { background:#111112 !important; color:#f2f2f0 !important; }
    .email-panel { background:#1a1b1e !important; }
    .invoice-email [style*="background:${C.paper}"] { background:#111112 !important; }
    .invoice-email [style*="color:${C.ink}"] { color:#f2f2f0 !important; }
    .invoice-email [style*="color:${C.muted}"], .invoice-items td[data-label]::before { color:#a6abb2 !important; }
    .invoice-email [style*="${C.hairline}"] { border-color:#36383d !important; }
    .invoice-email .email-button { background:#f2f2f0 !important; color:#111112 !important; }
  }
</style>` : ""}</head>
<body class="${invoicePresentation ? "invoice-email" : ""}" style="margin:0;padding:0;background:${C.paper};font-family:${EMAIL_FONT_STACK};color:${C.ink};">
  <div class="email-panel" style="max-width:600px;margin:40px auto;background:${C.panel};border:1px solid ${C.hairline};border-radius:10px;overflow:hidden;">
    <div class="email-brand" style="padding:24px 32px;border-bottom:1px solid ${C.hairline};">
      ${emailWordmark()}
    </div>
    <div class="email-content" style="padding:32px;">
      ${content}
    </div>
    <div style="padding:16px 32px;background:${C.paper};border-top:1px solid ${C.hairline};font-size:12px;color:${C.muted};text-align:center;">
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
  linkLabel?: string
  inlineFallback?: boolean
}) {
  const safeHref = escapeAttribute(input.href)
  return `
    <div style="margin-top:24px;padding-top:24px;border-top:1px solid ${C.hairline};">
      <a class="email-button" href="${safeHref}"
         style="${emailButtonStyle()}">
        ${escapeHtml(input.label)}
      </a>
      ${input.inlineFallback ? `<p style="margin:16px 0 0;color:${C.muted};font-size:14px;">${escapeHtml(input.fallbackLabel)} <a href="${safeHref}" style="color:${C.ink};">${escapeHtml(input.linkLabel ?? input.href)}</a></p>` : `<p style="margin:16px 0 0;color:${C.muted};font-size:14px;">${escapeHtml(input.fallbackLabel)}</p>
      <p style="margin:8px 0 0;font-size:14px;word-break:break-all;">
        <a href="${safeHref}" style="color:${C.ink};">${escapeHtml(input.linkLabel ?? input.href)}</a>
      </p>`}
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
    paymentReference?: string | null
    issueDate: Date | string
    supplyDate?: string | null
    buyer?: BuyerSnapshot | null
    dueDate: Date | string
    subtotal: number
    taxAmount: number
    total: number
    currency: string
    notes?: string | null
    /** Current outstanding amount; original totals above remain the issued invoice amounts. */
    balanceDue?: number
    /** Issue-time seller payment details. Never substitute current organization settings. */
    bankAccount?: BankAccountSnapshot | null
    paymentNote?: string | null
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
    companyAddress?: string | null
    taxIds?: DocumentTaxId[]
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
  const referenceHint = invoicePaymentReferenceHint(invoice, locale)
  const balanceDue = invoice.balanceDue ?? invoice.total
  const hasTransferDetails = hasPaymentDetails({ bankAccount: invoice.bankAccount, note: invoice.paymentNote })
  const showPaymentInstructions = balanceDue > 0 && (hasTransferDetails || Boolean(publicPaymentUrl))
  const html = layout(`
    <h2 style="margin:0 0 4px;font-size:22px;">${t("pdf.invoice", locale)} ${safeInvoiceNumber}</h2>
    <p style="margin:0 0 24px;color:${C.muted};">${t("email.invoice.greeting", locale, { name: safeContactName })}</p>

    <div class="invoice-parties" style="display:flex;gap:24px;justify-content:space-between;margin-bottom:8px;">
      <div>
        <div style="font-size:12px;color:${C.muted};text-transform:uppercase;margin-bottom:2px;">${t("pdf.from", locale)}</div>
        <div style="font-weight:500;">${escapeHtml(org.companyName ?? "")}</div>
        ${org.companyAddress ? `<div>${formatMultilineHtml(org.companyAddress)}</div>` : ""}
        ${invoiceTaxIds(org.taxIds, "CVR-nr.").map(id => `<div>${escapeHtml(id)}</div>`).join("")}
        ${safeCompanyEmail ? `<div style="color:${C.muted};font-size:14px;">${safeCompanyEmail}</div>` : ""}
      </div>
      <div class="invoice-dates" style="text-align:right;flex-shrink:0;">
        <div style="font-size:12px;color:${C.muted};text-transform:uppercase;margin-bottom:2px;">${t("pdf.issueDate", locale)}</div>
        <div style="font-weight:500;margin-bottom:12px;">${formatDate(invoice.issueDate, locale, org.timezone, { month: "short", dayFirst: true })}</div>
        ${invoice.supplyDate ? `<div style="font-size:12px;color:${C.muted};text-transform:uppercase;">${t("pdf.supplyDate", locale)}</div><div style="margin-bottom:12px;">${formatDate(invoice.supplyDate, locale, "UTC", { month: "short", dayFirst: true })}</div>` : ""}
        <div style="font-size:12px;color:${C.muted};text-transform:uppercase;margin-bottom:2px;">${t("pdf.dueDate", locale)}</div>
        <div style="font-weight:500;">${formatDate(invoice.dueDate, locale, "UTC", { month: "short", dayFirst: true })}</div>
      </div>
    </div>

    ${invoice.buyer ? `<div><div>${t("pdf.billTo", locale)}</div><div>${escapeHtml(invoice.buyer.name ?? "")}</div>${[invoice.buyer.company, ...buyerAddress(invoice.buyer)].filter(Boolean).map(value => `<div>${escapeHtml(value!)}</div>`).join("")}</div>` : ""}
    ${itemsTable(invoice.items, invoice.currency, locale, invoice.priceBasis, true)}
    ${totalsBlock(invoice, locale)}

    ${showPaymentInstructions ? `
    <h3 style="margin:24px 0 12px;font-size:16px;">${t("email.pay.heading", locale)}</h3>
    <table aria-label="${t("email.pay.heading", locale)}" style="width:100%;border-collapse:collapse;">
      ${invoicePaymentRows({ ...invoice, total: balanceDue }, locale).map(row => `<tr>
        <th scope="row" style="padding:10px 0;border-bottom:1px solid ${C.hairline};text-align:left;font-size:12px;font-weight:400;text-transform:uppercase;letter-spacing:0.06em;color:${C.muted};">${escapeHtml(row.label)}</th>
        <td style="padding:10px 0;border-bottom:1px solid ${C.hairline};text-align:right;font-family:'Geist Mono',Consolas,monospace;overflow-wrap:anywhere;">${escapeHtml(row.value)}</td>
      </tr>`).join("")}
    </table>
    ${hasTransferDetails && referenceHint ? `<p style="margin:12px 0;color:${C.muted};font-size:14px;">${escapeHtml(referenceHint)}</p>` : ""}
    ${invoice.paymentNote?.trim() ? `<p style="margin:12px 0;font-size:14px;">${formatMultilineHtml(invoice.paymentNote)}</p>` : ""}
    ${publicPaymentUrl
      ? actionBlock({
          href: publicPaymentUrl,
          label: t("email.pay.button", locale),
          linkLabel: t("email.invoice.payFallbackLink", locale),
          inlineFallback: true,
          fallbackLabel: t("email.invoice.payFallback", locale),
        })
      : ""}
    ` : ""}
    ${invoice.notes ? `<p style="margin-top:24px;color:${C.muted};font-size:14px;border-top:1px solid ${C.hairline};padding-top:16px;">${formatMultilineHtml(invoice.notes)}</p>` : ""}
  `, locale, true)

  const subject = sanitizeHeader(
    t("email.invoice.subject", locale, {
      number: invoice.number,
      total: formatCurrency(invoice.total, invoice.currency, locale),
      dueDate: formatDate(invoice.dueDate, locale, "UTC", { month: "short", dayFirst: true }),
    })
  )
  const fromAddressValue = formatSenderAddress(safeFromName, safeFromEmail)

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
  const html = layout(`
    <h2 style="margin:0 0 4px;font-size:22px;">${t("email.quote.title", locale)} ${safeQuoteNumber}</h2>
    <p style="margin:0 0 24px;color:${C.muted};">${t("email.quote.greeting", locale, { name: safeContactName })}</p>

    <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
      <div>
        <div style="font-size:12px;color:${C.muted};text-transform:uppercase;margin-bottom:2px;">${t("pdf.from", locale)}</div>
        <div style="font-weight:500;">${escapeHtml(safeFromName)}</div>
        ${safeCompanyEmail ? `<div style="color:${C.muted};font-size:14px;">${safeCompanyEmail}</div>` : ""}
      </div>
      <div style="text-align:right;">
        <div style="font-size:12px;color:${C.muted};text-transform:uppercase;margin-bottom:2px;">${t("email.quote.validUntil", locale)}</div>
        <div style="font-weight:500;">${formatDate(quote.expiryDate, locale, "UTC", { month: "long" })}</div>
      </div>
    </div>

    ${itemsTable(quote.items, quote.currency, locale, quote.priceBasis)}
    ${totalsBlock(quote, locale)}

    ${quote.notes ? `<p style="margin-top:24px;color:${C.muted};font-size:14px;border-top:1px solid ${C.hairline};padding-top:16px;">${formatMultilineHtml(quote.notes)}</p>` : ""}
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
      expiryDate: formatDate(quote.expiryDate, locale, "UTC", { month: "long" }),
    })
  )
  const fromAddressValue = formatSenderAddress(safeFromName, safeFromEmail)

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
    <p style="color:${C.muted};margin-bottom:32px;">${t("email.invitation.body", locale, { inviterName: safeInviterName })}</p>
    <a href="${safeInvitationUrl}"
       style="${emailButtonStyle()}">
      ${t("email.invitation.accept", locale)}
    </a>
    <p style="margin-top:24px;font-size:12px;color:${C.muted};">
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
