import type { CountryModule, NationalRegistration, TaxIdSchemeOption, TaxRegimeModule } from "./country-module"
import type { CountryProfile } from "./country-profile"
import { denmark } from "./countries/dk"
import { germany } from "./countries/de"
import { france } from "./countries/fr"
import { netherlands } from "./countries/nl"
import { unitedStates } from "./countries/us"
import { euVatRegime } from "./regimes/eu-vat"
import { usSalesTaxRegime } from "./regimes/us-sales-tax"

/** Every supported country. Adding a country means adding its module here. */
export const COUNTRY_MODULES: readonly CountryModule[] = [unitedStates, denmark, germany, france, netherlands]

export const TAX_REGIME_MODULES: readonly TaxRegimeModule[] = [usSalesTaxRegime, euVatRegime]

const byCode = new Map(COUNTRY_MODULES.map((country) => [country.countryCode, country]))

/** An ISO 3166 alpha-2 code in upper case, or null when the value is not one. */
export function normalizeCountryCode(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase() ?? ""
  return /^[A-Z]{2}$/.test(code) ? code : null
}

export function findCountryModule(countryCode: string | null | undefined): CountryModule | null {
  const code = normalizeCountryCode(countryCode)
  return code ? (byCode.get(code) ?? null) : null
}

/** The country's tax regime, also for regime members without a country module of their own. */
export function findTaxRegime(countryCode: string | null | undefined): TaxRegimeModule | null {
  const code = normalizeCountryCode(countryCode)
  if (!code) return null
  return byCode.get(code)?.regime ?? TAX_REGIME_MODULES.find((regime) => regime.memberCountries.has(code)) ?? null
}

/**
 * The rules that apply to a country. A country without a module is unsupported: its regime's
 * rules still apply when it belongs to one, but no national rules and no defaults do.
 */
export function resolveCountryProfile(countryCode: string | null | undefined): CountryProfile {
  return {
    countryCode: normalizeCountryCode(countryCode),
    country: findCountryModule(countryCode),
    regime: findTaxRegime(countryCode),
  }
}

/** The country whose name appears first in free text, using each module's keywords. */
export function findCountryInText(text: string): CountryModule | null {
  const lower = text.toLowerCase()
  let found: { country: CountryModule; index: number } | null = null
  for (const country of COUNTRY_MODULES) {
    for (const keyword of country.keywords) {
      const match = new RegExp(`\\b${keyword}\\b`).exec(lower)
      if (match && (!found || match.index < found.index)) found = { country, index: match.index }
    }
  }
  return found?.country ?? null
}

/** A national registration scheme by the tax-ID scheme it is stored under, in any country. */
export function nationalRegistrationForScheme(scheme: string | null | undefined): NationalRegistration | null {
  const key = scheme?.trim().toLowerCase()
  if (!key) return null
  for (const country of COUNTRY_MODULES) {
    const registration = country.nationalRegistration
    if (registration && (registration.scheme === key || registration.aliases.includes(key))) return registration
  }
  return null
}

/** Whether a tax ID stored under this scheme is the country's national registration number. */
export function isNationalRegistrationScheme(scheme: string | null | undefined, countryCode: string | null | undefined) {
  const registration = findCountryModule(countryCode)?.nationalRegistration
  return registration !== undefined && registration === nationalRegistrationForScheme(scheme)
}

/** Whether a tax ID stored under this scheme holds a VAT number in some supported country. */
export function isVatNumberScheme(scheme: string | null | undefined): boolean {
  const key = scheme?.trim().toLowerCase()
  if (!key) return false
  return TAX_REGIME_MODULES.some((regime) => regime.vatIdScheme === key) || nationalRegistrationForScheme(key) !== null
}

/** Primary tax-ID schemes offered to an organization in this country. */
export function taxIdSchemeOptions(countryCode: string | null | undefined): TaxIdSchemeOption[] {
  const regime = findTaxRegime(countryCode)
  const registration = findCountryModule(countryCode)?.nationalRegistration
  const options = regime
    ? [...regime.taxIdSchemes]
    : TAX_REGIME_MODULES.flatMap((candidate) => candidate.taxIdSchemes)
  if (registration) options.push({ value: registration.scheme, label: registration.label })
  return options
}
