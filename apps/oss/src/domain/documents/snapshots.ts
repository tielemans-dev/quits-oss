import type { BuyerSnapshot, SellerSnapshot } from "@quits/contracts/documents"
import type { TaxId } from "../../lib/compliance"
import { paymentSnapshotFromColumns, type PaymentDetailsColumns } from "../../lib/payment-details"

export function buildSellerSnapshot(
  settings: { countryCode?: string | null; companyName: string | null; companyEmail: string | null; companyAddress: string | null },
  taxIds: TaxId[]
): SellerSnapshot {
  return {
    ...(settings.countryCode ? { countryCode: settings.countryCode } : {}),
    companyName: settings.companyName ?? null,
    companyEmail: settings.companyEmail ?? null,
    companyAddress: settings.companyAddress ?? null,
    taxIds,
  }
}

/**
 * Invoices carry the payment details valid when they are issued, so payers always see the account
 * the seller named at that time: the bank account in `bankAccount` and the organization's note in
 * `paymentNote`. Quotes, credit notes and agreements do not take payments and keep the plain
 * seller snapshot. An organization without payment details gets neither key.
 */
export function withInvoicePaymentDetails<T extends SellerSnapshot>(
  seller: T,
  settings: Partial<PaymentDetailsColumns>
): T {
  const { bankAccount: _account, paymentNote: _note, ...rest } = seller
  return { ...rest, ...paymentSnapshotFromColumns(settings) } as T
}

/**
 * A credit note takes its seller from the invoice it corrects, but payment details only belong on
 * the invoice: the note must not carry payment instructions for a document it reduces.
 */
export function withoutPaymentDetails<T>(snapshot: T): T {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot
  if (!("bankAccount" in snapshot) && !("paymentNote" in snapshot)) return snapshot
  const { bankAccount: _account, paymentNote: _note, ...rest } = snapshot as Record<string, unknown>
  return rest as T
}

export function buildBuyerSnapshot(contact: {
  name: string
  email: string | null
  company: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  country: string | null
  taxIds?: TaxId[]
  taxId?: string | null
}): BuyerSnapshot {
  return {
    name: contact.name,
    email: contact.email ?? null,
    company: contact.company ?? null,
    address: contact.address ?? null,
    city: contact.city ?? null,
    state: contact.state ?? null,
    zip: contact.zip ?? null,
    country: contact.country ?? null,
    taxIds: contact.taxIds?.map(({ scheme, value, countryCode }) => ({ scheme, value, countryCode })) ?? (contact.taxId ? [{ scheme: "VAT", value: contact.taxId, countryCode: contact.country }] : []),
  }
}

export const buyerContactSelect = {
  id: true,
  name: true,
  email: true,
  company: true,
  address: true,
  city: true,
  state: true,
  zip: true,
  country: true,
  taxId: true,
  taxIds: { select: { scheme: true, value: true, countryCode: true } },
} as const
