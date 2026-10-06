export type TaxRegime = "us_sales_tax" | "eu_vat"

export type CountryProfile = {
  countryCode: "US" | "DK" | "EU"
  defaultLocale: string
  defaultCurrency: string
  taxRegime: TaxRegime
  requiresSellerTaxId: boolean
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
