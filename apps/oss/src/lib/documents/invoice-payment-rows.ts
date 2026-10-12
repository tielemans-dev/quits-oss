import type { BankAccountSnapshot } from "@quits/contracts/payment-details"
import { bankAccountRows } from "../payment-details-block"
import { formatCurrency, formatDate } from "../i18n/format"
import type { TranslationKey } from "../i18n/messages"
import { translate } from "../i18n/translate"

/** Display spacing only. Never pad, truncate, or change a stored account number. */
export function groupAccountNumber(value: string): string {
  const trimmed = value.trim()
  return /^\d{10}$/.test(trimmed) ? `${trimmed.slice(0, 4)} ${trimmed.slice(4, 7)} ${trimmed.slice(7)}` : trimmed
}

type InvoicePaymentReference = { number: string | null; paymentReference?: string | null }

function paymentMessageForInvoice(input: InvoicePaymentReference) {
  return input.paymentReference?.trim() || input.number?.trim()
}

/** Keep the approved default hint; custom messages must name the same value as the row. */
export function invoicePaymentReferenceHint(input: InvoicePaymentReference, locale?: string | null) {
  const reference = paymentMessageForInvoice(input)
  if (!reference) return null
  return reference === input.number?.trim()
    ? translate("email.pay.reference", locale)
    : translate("email.pay.customReference", locale, { reference })
}

/** The same stored payment message and frozen destination rows in email and the app. */
export function invoicePaymentRows(input: {
  bankAccount?: BankAccountSnapshot | null
  number: string | null
  paymentReference?: string | null
  total: number
  currency: string
  dueDate: Date | string
}, locale?: string | null) {
  const entries: Array<[TranslationKey, string | null | undefined]> = [
    ["email.pay.amount", formatCurrency(input.total, input.currency, locale)],
    ["email.pay.due", formatDate(input.dueDate, locale, "UTC", { month: "short", dayFirst: true })],
  ]
  const bankRows = bankAccountRows(input.bankAccount, locale).map(row => {
    const key = row.key === "pdf.regNumber" ? "email.pay.reg" : row.key === "pdf.accountNumber" ? "email.pay.account" : row.key
    return { key, label: translate(key, locale), value: row.key === "pdf.accountNumber" ? groupAccountNumber(row.value) : row.value }
  })
  const paymentMessage = paymentMessageForInvoice(input)
  const reference = paymentMessage
    ? [{ key: "email.pay.referenceLabel" as const, label: translate("email.pay.referenceLabel", locale), value: paymentMessage }]
    : []
  return [...entries.flatMap(([key, value]) => value?.trim() ? [{ key, label: translate(key, locale), value: value.trim() }] : []), ...bankRows, ...reference]
}
