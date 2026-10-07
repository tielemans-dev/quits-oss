import type { BuyerSnapshot, SellerSnapshot } from "@quits/contracts/documents"
import type { TaxId } from "../../lib/compliance"

export function buildSellerSnapshot(
  settings: { companyName: string | null; companyEmail: string | null; companyAddress: string | null },
  taxIds: TaxId[]
): SellerSnapshot {
  return {
    companyName: settings.companyName ?? null,
    companyEmail: settings.companyEmail ?? null,
    companyAddress: settings.companyAddress ?? null,
    taxIds,
  }
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
