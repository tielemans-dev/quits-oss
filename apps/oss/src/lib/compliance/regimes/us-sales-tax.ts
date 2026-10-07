import type { TaxRegimeModule } from "../country-module"

export const usSalesTaxRegime: TaxRegimeModule = {
  id: "us_sales_tax",
  memberCountries: new Set(["US"]),
  requiresSellerTaxId: false,
  appliesToIndividuals: true,
  vatIdScheme: null,
  taxIdSchemes: [{ value: "ein", label: "EIN" }],
  primaryTaxIdCopy: {
    label: "Tax ID",
    help: "Only needed when your selected tax setup requires it.",
  },
}
