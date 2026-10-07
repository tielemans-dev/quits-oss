import type { CountryModule } from "../country-module"
import { euVatRegime } from "../regimes/eu-vat"

export const germany: CountryModule = {
  countryCode: "DE",
  label: "Germany",
  keywords: ["germany", "de"],
  regime: euVatRegime,
  defaults: { locale: "de-DE", currency: "EUR", timezone: "Europe/Berlin", pricesIncludeTax: true },
  formats: {
    phone: /^(\+49[\s-]?)?(0)?[1-9]\d{6,13}$/,
    postalCode: /^\d{5}$/,
    taxId: [/^DE\d{9}$/i, /^\d{9}$/],
  },
}
