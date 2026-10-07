import { COUNTRY_MODULES, countryLabel, normalizeCountryCode } from "./registry"

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

/**
 * The supported countries, plus the current one when it has no module, so a form can show and
 * keep a country Quits does not support yet.
 */
export function countryOptionsIncluding(current: string | null | undefined): Array<{ code: string; label: string }> {
  const code = normalizeCountryCode(current)
  const label = countryLabel(code)
  if (!code || !label || COUNTRY_OPTIONS.some((option) => option.code === code)) return COUNTRY_OPTIONS
  return [...COUNTRY_OPTIONS, { code, label }]
}

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
