import type { CountryModule } from "../country-module"
import { euVatRegime } from "../regimes/eu-vat"

export const netherlands: CountryModule = {
  countryCode: "NL",
  label: "Netherlands",
  keywords: ["netherlands", "nl"],
  regime: euVatRegime,
  defaults: { locale: "nl-NL", currency: "EUR", timezone: "Europe/Amsterdam", pricesIncludeTax: true },
  formats: {
    phone: /^(\+31[\s-]?)?(0)?[1-9]\d{8}$/,
    postalCode: /^\d{4}\s?[A-Z]{2}$/i,
    taxId: [/^NL\d{9}B\d{2}$/i],
  },
}
