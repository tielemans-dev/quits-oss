import type { TaxRegimeModule } from "../country-module"

export const euVatRegime: TaxRegimeModule = {
  id: "eu_vat",
  memberCountries: new Set([
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
    "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  ]),
  requiresSellerTaxId: true,
  appliesToIndividuals: false,
  vatIdScheme: "vat",
  taxIdSchemes: [{ value: "vat", label: "VAT" }],
  primaryTaxIdCopy: {
    label: "VAT number",
    help: "Required for registered businesses using EU VAT.",
  },
}
