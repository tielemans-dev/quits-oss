import { COUNTRY_MODULES } from "./registry"

export type CountryOption = {
  code: string
  label: string
  defaultLocale: string
  defaultCurrency: string
}

export const COUNTRY_OPTIONS: CountryOption[] = COUNTRY_MODULES.map((country) => ({
  code: country.countryCode,
  label: country.label,
  defaultLocale: country.defaults.locale,
  defaultCurrency: country.defaults.currency,
}))

export const LOCALE_OPTIONS = [
  "en-US",
  "da-DK",
  "de-DE",
  "fr-FR",
  "nl-NL",
  "en-GB",
  "es-ES",
]

export const TAX_REGIMES = [
  { value: "us_sales_tax", label: "US Sales Tax" },
  { value: "eu_vat", label: "EU VAT" },
  { value: "custom", label: "Custom" },
] as const
