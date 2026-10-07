import { findCountryModule, normalizeCountryCode } from "../compliance/registry"

// Countries without a module are checked against these loose formats only.
const GENERIC_PHONE = /^\+?[0-9()[\]\-.\s]{6,20}$/
const GENERIC_POSTAL_CODE = /^[A-Z0-9][A-Z0-9\s-]{2,12}$/i
const GENERIC_TAX_ID = /^[A-Z0-9-]{4,20}$/i

function stripSpaces(value: string) {
  return value.replace(/\s+/g, "")
}

export { normalizeCountryCode }

export function isValidPhoneForCountry(countryCode: string | null, phone: string) {
  const trimmed = phone.trim()
  if (!trimmed) return true
  return (findCountryModule(countryCode)?.formats.phone ?? GENERIC_PHONE).test(trimmed)
}

export function isValidPostalCodeForCountry(countryCode: string | null, postalCode: string) {
  const trimmed = postalCode.trim()
  if (!trimmed) return true
  return (findCountryModule(countryCode)?.formats.postalCode ?? GENERIC_POSTAL_CODE).test(trimmed)
}

export function isValidTaxIdForCountry(countryCode: string | null, taxId: string) {
  const trimmed = stripSpaces(taxId.trim())
  if (!trimmed) return true
  const patterns = findCountryModule(countryCode)?.formats.taxId ?? [GENERIC_TAX_ID]
  return patterns.some((pattern) => pattern.test(trimmed))
}

export function validateLocalizedFields(
  countryCode: string | null,
  input: { phone?: string | null; postalCode?: string | null; taxId?: string | null }
) {
  const issues: { phone?: string; postalCode?: string; taxId?: string } = {}

  if (input.phone && !isValidPhoneForCountry(countryCode, input.phone)) {
    issues.phone = "Phone number format does not match selected country."
  }

  if (input.postalCode && !isValidPostalCodeForCountry(countryCode, input.postalCode)) {
    issues.postalCode = "Postal code format does not match selected country."
  }

  if (input.taxId && !isValidTaxIdForCountry(countryCode, input.taxId)) {
    issues.taxId = "Tax ID format does not match selected country."
  }

  return issues
}

