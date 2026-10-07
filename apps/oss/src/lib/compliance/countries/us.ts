import type { CountryModule } from "../country-module"
import { usSalesTaxRegime } from "../regimes/us-sales-tax"

export const unitedStates: CountryModule = {
  countryCode: "US",
  label: "United States",
  keywords: ["united states", "usa", "us"],
  regime: usSalesTaxRegime,
  defaults: { locale: "en-US", currency: "USD", timezone: "America/New_York", pricesIncludeTax: false },
  formats: {
    phone: /^(\+1[\s-]?)?(\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}$/,
    postalCode: /^\d{5}(?:-\d{4})?$/,
    taxId: [/^\d{2}-\d{7}$/],
  },
}
