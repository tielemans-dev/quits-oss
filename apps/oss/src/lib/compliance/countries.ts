import { z } from "zod"
import { COUNTRY_MODULES, countryLabel, isCountryCode, normalizeCountryCode } from "./registry"

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

/**
 * The canonical form of a locale whose language Intl can format and whose region, if any, is a
 * country or a numeric UN region (es-419). Null otherwise; Intl alone would accept en-XX.
 */
export function canonicalLocale(value: string | null | undefined): string | null {
  try {
    const locale = new Intl.Locale(value?.trim() ?? "")
    const region = locale.region
    if (region && !isCountryCode(region) && !/^\d{3}$/.test(region)) return null
    return Intl.DateTimeFormat.supportedLocalesOf(locale.language).length > 0 ? locale.toString() : null
  } catch {
    return null
  }
}

/** Any formattable locale, not only the suggested ones, stored in canonical form. */
export const localeSchema = z
  .string()
  .trim()
  .refine((value) => canonicalLocale(value) !== null, "Unsupported locale")
  .transform((value) => canonicalLocale(value) ?? value)

/** The suggested locales, plus the current one when it is not among them. */
export function localeOptionsIncluding(current: string | null | undefined): string[] {
  return current && !LOCALE_OPTIONS.includes(current) ? [...LOCALE_OPTIONS, current] : LOCALE_OPTIONS
}

export const TAX_REGIMES = [
  { value: "us_sales_tax", label: "US Sales Tax" },
  { value: "eu_vat", label: "EU VAT" },
  { value: "custom", label: "Custom" },
] as const
