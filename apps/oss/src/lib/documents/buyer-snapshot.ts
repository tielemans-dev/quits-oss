import type { BuyerSnapshot } from "@quits/contracts/documents"
import type { TaxId } from "../compliance"
import { toCountryCode } from "../exports/parties"

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
