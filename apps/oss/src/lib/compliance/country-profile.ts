import type { CountryModule, TaxRegimeModule } from "./country-module"

export type TaxRegime = "us_sales_tax" | "eu_vat"

/** The rules resolved for a country code. See `resolveCountryProfile`. */
export type CountryProfile = {
  countryCode: string | null
  /** Null when Quits has no module for the country, so no national rules apply. */
  country: CountryModule | null
  /** Null when the country belongs to no supported tax regime. */
  regime: TaxRegimeModule | null
}

export type ComplianceSeverity = "error" | "warning"

export type ComplianceError = {
  code: string
  severity: ComplianceSeverity
  message: string
  fieldPath?: string
  hint?: string
}

export type TaxId = {
  scheme?: string
  value: string
  countryCode?: string | null
}

export type ValidationInput = {
  sellerTaxIds: TaxId[]
  buyerTaxIds: TaxId[]
  taxRate: number
}
