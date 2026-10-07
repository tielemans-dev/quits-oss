import type { CountryModule } from "../country-module"
import { euVatRegime } from "../regimes/eu-vat"

export const france: CountryModule = {
  countryCode: "FR",
  label: "France",
  keywords: ["france", "fr"],
  regime: euVatRegime,
  defaults: { locale: "fr-FR", currency: "EUR", timezone: "Europe/Paris", pricesIncludeTax: true },
  formats: {
    phone: /^(\+33[\s-]?)?(0)?[1-9](?:[\s.-]?\d{2}){4}$/,
    postalCode: /^\d{5}$/,
    taxId: [/^FR[A-Z0-9]{2}\d{9}$/i],
  },
}
