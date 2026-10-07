import type { TaxRegime } from "./country-profile"

/**
 * Country rules live in modules so the core never branches on a country code. A tax regime holds
 * the rules its member countries share; a country module adds what is national. Register both in
 * `registry.ts`.
 */

export type TaxIdSchemeOption = { value: string; label: string }

/** Rules shared by every country in a tax regime. */
export type TaxRegimeModule = {
  id: TaxRegime
  /** Countries the regime covers, including those without a country module. */
  memberCountries: ReadonlySet<string>
  /** Whether a seller must hold a tax ID before issuing documents. */
  requiresSellerTaxId: boolean
  /** Whether individuals invoice under this regime too; otherwise onboarding suggests "custom". */
  appliesToIndividuals: boolean
  /** The tax-ID scheme that holds a VAT number, when the regime has one. */
  vatIdScheme: string | null
  /** Schemes offered for the organization's primary tax ID. */
  taxIdSchemes: readonly TaxIdSchemeOption[]
  primaryTaxIdCopy: { label: string; help: string }
}

/**
 * A national registration number that doubles as the VAT number, such as Denmark's CVR. E-invoices
 * carry it as the legal identifier under its ISO 6523 ICD.
 */
export type NationalRegistration = {
  /** Tax-ID scheme Quits stores it under, plus older spellings. */
  scheme: string
  aliases: readonly string[]
  label: string
  icd: string
  normalize: (value: string) => string
  /** The registration number inside a prefixed VAT number, when it is one. */
  fromVatId: (vatId: string) => string | null
  /** Whether Peppol national rules require it on the seller's e-invoices. */
  requiredForSeller: boolean
}

export type CountryModule = {
  countryCode: string
  label: string
  /** Lowercase words that name the country in free text, for onboarding heuristics. */
  keywords: readonly string[]
  regime: TaxRegimeModule
  defaults: {
    locale: string
    currency: string
    timezone: string
    pricesIncludeTax: boolean
  }
  formats: {
    phone: RegExp
    postalCode: RegExp
    taxId: readonly RegExp[]
  }
  /** Overrides the regime's copy for the primary tax ID field. */
  primaryTaxIdCopy?: { label: string; help: string }
  nationalRegistration?: NationalRegistration
}
