import { invoiceAllowsPayment } from "../../lib/payments/invoice-methods"
import { Effect } from "effect"
import { InvalidState } from "../errors"
import { localizedNonVatPaymentNote } from "../../lib/documents/non-vat-note"
import { parseSellerSnapshot, type BuyerSnapshot, type SellerSnapshot } from "@quits/contracts/documents"
import { isNationalRegistrationScheme } from "../../lib/compliance"
import type { TaxId } from "../../lib/compliance"
import { paymentSnapshotFromColumns, type PaymentDetailsColumns } from "../../lib/payment-details"
import { toCountryCode } from "../../lib/exports/parties"

export function buildSellerSnapshot(
  settings: { seNumber?: string | null; momsRegistered?: boolean | null; countryCode?: string | null; companyName: string | null; companyEmail: string | null; companyAddress: string | null },
  taxIds: TaxId[]
): SellerSnapshot {
  return {
    ...(settings.momsRegistered != null ? { momsRegistered: settings.momsRegistered } : {}),
    ...(settings.countryCode ? { countryCode: settings.countryCode } : {}),
    companyName: settings.companyName ?? null,
    companyEmail: settings.companyEmail ?? null,
    companyAddress: settings.companyAddress ?? null,
    taxIds: [...taxIds, ...(settings.seNumber?.trim() ? [{ scheme: "se", value: settings.seNumber.trim(), countryCode: "DK" }] : [])],
  }
}

/** A linked draft retains agreed identity, but registration is rechecked at invoice issuance. */
export function buildInvoiceSellerSnapshot(
  invoice: { agreementId?: string | null; quoteId?: string | null; sellerSnapshot: unknown },
  settings: Parameters<typeof buildSellerSnapshot>[0],
  taxIds: TaxId[]
): SellerSnapshot {
  if (!invoice.agreementId && !invoice.quoteId) return buildSellerSnapshot(settings, taxIds)
  return { ...parseSellerSnapshot(invoice.sellerSnapshot), momsRegistered: settings.momsRegistered ?? null }
}

/**
 * Invoices carry the payment details valid when they are issued, so payers always see the account
 * the seller named at that time: the bank account in `bankAccount` and the organization's note in
 * `paymentNote`. Quotes, credit notes and agreements do not take payments and keep the plain
 * seller snapshot. An organization without payment details gets neither key.
 */
export function withInvoicePaymentDetails<T extends SellerSnapshot>(
  seller: T,
  settings: Partial<PaymentDetailsColumns>,
  locale?: string | null,
  paymentMethods?: unknown
): T {
  const { bankAccount: _account, paymentNote: _note, ...rest } = seller
  const payment = paymentSnapshotFromColumns({ ...settings, paymentNote: localizedNonVatPaymentNote(settings.paymentNote, seller.momsRegistered, locale) ?? null })
  if (!invoiceAllowsPayment(paymentMethods, "bank_transfer")) delete payment.bankAccount
  return { ...rest, ...payment } as T
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
    taxIds: contact.taxIds?.length
      ? contact.taxIds.map(({ scheme, value, countryCode }) => ({ scheme, value, countryCode }))
      : contact.taxId?.trim() ? [contactTaxId(contact.taxId.trim(), contact.country)] : [],
  }
}

/**
 * A contact's single tax ID field, as a CVR lookup or the customer form fills it. A Danish
 * customer's 8-digit number is their CVR; any other number is kept as a VAT number.
 */
function contactTaxId(value: string, country: string | null): TaxId {
  const countryCode = toCountryCode(country)
  const cvr = value.replace(/[\s.\-/]/g, "").toUpperCase().replace(/^DK/, "")
  return countryCode === "DK" && /^\d{8}$/.test(cvr)
    ? { scheme: "cvr", value: cvr, countryCode }
    : { scheme: "VAT", value, countryCode: countryCode ?? country }
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

/** Current registration confirms only the same seller, never a different agreed legal identity. */
export function withSellerVatStatus<T extends SellerSnapshot>(seller: T, current: SellerSnapshot, taxRegime: string) {
  const country = seller.countryCode?.trim().toUpperCase()
  const currentCountry = current.countryCode?.trim().toUpperCase()
  // Other regimes retain the agreed legal identity and its frozen registration status.
  if (taxRegime !== "eu_vat" || (country !== "DK" && currentCountry !== "DK")) return Effect.succeed(seller)
  const cvrIds = (snapshot: SellerSnapshot) => [...new Set((snapshot.taxIds ?? [])
    .filter(id => isNationalRegistrationScheme(id.scheme, "DK") && (id.countryCode ?? snapshot.countryCode)?.toUpperCase() === "DK")
    .map(id => id.value.trim()))].sort()
  const retainedCvr = cvrIds(seller), currentCvr = cvrIds(current)
  const taxIdentity = (snapshot: SellerSnapshot) => JSON.stringify((snapshot.taxIds ?? [])
    .map(id => [id.scheme?.toLowerCase() ?? "", id.countryCode?.toUpperCase() ?? "", id.value.trim()])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
  // A Danish CVR identifies the legal seller despite trading-name/address changes. Without it,
  // require the full known postal identity and identifiers, rather than guessing from a name.
  const sameSeller = country && country === currentCountry && (country === "DK" && (retainedCvr.length || currentCvr.length)
    ? retainedCvr.length === 1 && currentCvr.length === 1 && /^\d{8}$/.test(retainedCvr[0]!) && retainedCvr[0] === currentCvr[0]
    : Boolean(seller.companyName?.trim() && seller.companyAddress?.trim()) &&
      seller.companyName === current.companyName && seller.companyAddress === current.companyAddress &&
      taxIdentity(seller) === taxIdentity(current))
  return sameSeller
    ? Effect.succeed({ ...seller, momsRegistered: current.momsRegistered })
    : Effect.fail(new InvalidState({ code: "seller_identity_changed", message: "The agreed seller differs from company settings. Restore and confirm VAT registration for the agreed seller, or create a new quote or agreement with the current seller before issuing." }))
}

/** Historical credits inherit known identity, but never today's VAT registration or payment details. */
export function creditSellerSnapshot(
  source: unknown,
  settings: Parameters<typeof buildSellerSnapshot>[0],
  taxIds: TaxId[]
): unknown {
  if (source !== null && source !== undefined) return withoutPaymentDetails(source)
  return buildSellerSnapshot({ ...settings, momsRegistered: undefined }, taxIds)
}
