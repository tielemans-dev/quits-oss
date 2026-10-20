import { countryOptionsIncluding, localeOptionsIncluding } from "./compliance/countries"
import { findCountryModule, normalizeCountryCode } from "./compliance/registry"

export type PickerOption = { value: string; label: string }

/** The currencies an organization can invoice in by default. */
export const CURRENCY_CODES = ["USD", "DKK", "EUR", "GBP", "CAD", "AUD"] as const
export type CurrencyCode = (typeof CURRENCY_CODES)[number]

/**
 * The organization's own choice first, then the rest alphabetically in the UI language. A fixed
 * source order would put the first-listed country or currency (USA, US dollars) at the top for everyone.
 */
export function ownFirstThenAlphabetical<T extends PickerOption>(options: readonly T[], own: string | null | undefined, uiLocale: string): T[] {
  const collator = new Intl.Collator(uiLocale)
  const rest = options.filter((option) => option.value !== own).sort((a, b) => collator.compare(a.label, b.label))
  const pinned = options.find((option) => option.value === own)
  return pinned ? [pinned, ...rest] : rest
}

/** A document locale such as en-GB named in the UI language ("British English", "Britisk engelsk"). */
export function localeDisplayName(locale: string, uiLocale: string): string {
  let name: string | undefined
  try {
    name = new Intl.DisplayNames([uiLocale], { type: "language", fallback: "none" }).of(locale)
  } catch {
    return locale
  }
  if (!name) return locale
  return name.charAt(0).toLocaleUpperCase(uiLocale) + name.slice(1)
}

/** Supported countries, plus the current one, with the organization's country first. */
export function countryPickerOptions(current: string | null | undefined, ownCountry: string | null | undefined, uiLocale: string): PickerOption[] {
  const names = new Intl.DisplayNames([uiLocale], { type: "region" })
  const options = countryOptionsIncluding(current).map((country) => ({ value: country.code, label: names.of(country.code) ?? country.label }))
  return ownFirstThenAlphabetical(options, normalizeCountryCode(ownCountry), uiLocale)
}

/** Document locales, plus the current one, with the organization country's own locale first. */
export function localePickerOptions(current: string | null | undefined, ownCountry: string | null | undefined, uiLocale: string): PickerOption[] {
  const options = localeOptionsIncluding(current).map((locale) => ({ value: locale, label: localeDisplayName(locale, uiLocale) }))
  return ownFirstThenAlphabetical(options, findCountryModule(ownCountry)?.defaults.locale, uiLocale)
}

/** Currencies named by `name`, with the organization country's own currency first. */
export function currencyPickerOptions(
  codes: readonly CurrencyCode[],
  ownCountry: string | null | undefined,
  uiLocale: string,
  name: (code: CurrencyCode) => string,
): Array<PickerOption & { value: CurrencyCode }> {
  const options = codes.map((code) => ({ value: code, label: name(code) }))
  return ownFirstThenAlphabetical(options, findCountryModule(ownCountry)?.defaults.currency, uiLocale)
}
