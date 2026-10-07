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

export type DocumentLineInput = {
  description: string
  quantity: number
  unitPrice: number
}

export type TaxComputationInput = {
  items: DocumentLineInput[]
  taxRate: number
  pricesIncludeTax: boolean
  /** Decimals line and document amounts are rounded to; 0 for currencies such as JPY. Default 2. */
  fractionDigits?: number
}

export type ComputedLine = {
  description: string
  quantity: number
  unitPriceNet: number
  unitPriceGross: number
  lineNet: number
  lineTax: number
  lineGross: number
  taxRate: number
}

export type TaxComputationOutput = {
  subtotalNet: number
  totalTax: number
  totalGross: number
  lines: ComputedLine[]
}

export type ValidationInput = {
  sellerTaxIds: TaxId[]
  buyerTaxIds: TaxId[]
  taxRate: number
}
