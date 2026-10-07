import type { CountryModule } from "../country-module"
import { euVatRegime } from "../regimes/eu-vat"

function compact(value: string) {
  return value.replace(/[\s.\-/]/g, "").toUpperCase()
}

export const denmark: CountryModule = {
  countryCode: "DK",
  label: "Denmark",
  keywords: ["denmark", "danish", "dk"],
  regime: euVatRegime,
  defaults: { locale: "da-DK", currency: "DKK", timezone: "Europe/Copenhagen", pricesIncludeTax: true },
  formats: {
    phone: /^(\+45\s?)?\d{8}$/,
    postalCode: /^\d{4}$/,
    taxId: [/^\d{8}$/, /^DK\d{8}$/i],
  },
  primaryTaxIdCopy: {
    label: "VAT/CVR number",
    help: "Required for Danish registered businesses using EU VAT.",
  },
  // The CVR number doubles as the VAT number. DK-R-002 and DK-R-014 require Danish suppliers to
  // give it as their legal identifier with ICD 0184.
  nationalRegistration: {
    scheme: "cvr",
    aliases: ["dk_cvr"],
    label: "CVR",
    icd: "0184",
    normalize: (value) => compact(value).replace(/^DK(?=\d)/, ""),
    fromVatId: (vatId) => {
      const value = compact(vatId)
      if (!value.startsWith("DK")) return null
      const digits = value.slice(2)
      return /^\d{8}$/.test(digits) ? digits : null
    },
    requiredForSeller: true,
  },
}
