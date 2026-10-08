import { formatIban, hasPaymentDetails, type BankAccountSnapshot } from "@quits/contracts/payment-details"
import type { TranslationKey } from "./i18n/messages"
import { translate } from "./i18n/translate"

export type PaymentDetailsBlock = {
  title: string
  rows: Array<{ label: string; value: string }>
  note: string | null
  reference: { label: string; value: string }
}

/**
 * The "Payment details" block of an invoice, or null when there is nothing to pay to. The invoice
 * number is the payment reference, so a bank transfer can be matched to the invoice. The PDF and
 * the settings preview both build the block here, so they cannot drift apart.
 */
export function buildPaymentDetailsBlock(
  details: { bankAccount?: BankAccountSnapshot | null; note?: string | null } | null | undefined,
  invoiceNumber: string,
  locale: string | null | undefined
): PaymentDetailsBlock | null {
  if (!details || !hasPaymentDetails(details)) return null
  const account = details.bankAccount
  const entries: Array<[TranslationKey, string | null | undefined]> = [
    ["pdf.regNumber", account?.regNumber],
    ["pdf.accountNumber", account?.accountNumber],
    ["pdf.iban", account?.iban ? formatIban(account.iban) : null],
    ["pdf.bic", account?.bic],
    ["pdf.accountHolder", account?.accountHolder],
    ["pdf.bankName", account?.bankName],
  ]
  return {
    title: translate("pdf.paymentDetails", locale),
    rows: entries.flatMap(([key, value]) =>
      value?.trim() ? [{ label: translate(key, locale), value: value.trim() }] : []
    ),
    note: details.note?.trim() || null,
    reference: { label: translate("pdf.paymentReference", locale), value: invoiceNumber },
  }
}
