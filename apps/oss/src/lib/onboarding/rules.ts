import type { OnboardingTaxRegime } from "@quits/contracts/onboarding"
import {
  findCountryModule,
  findTaxRegime,
  normalizeCountryCode,
  taxIdSchemeOptions,
} from "../compliance/registry"
import type { TaxIdSchemeOption } from "../compliance/country-module"

export type OnboardingInvoicingIdentity = "individual" | "registered_business"

type OnboardingRulesInput = {
  countryCode?: string | null
  invoicingIdentity?: string | null
  taxRegime?: OnboardingTaxRegime | string | null
}

type OnboardingPrimaryTaxIdCopy = {
  label: string
  help: string
}

export type OnboardingRules = {
  defaults: {
    locale: string
    timezone: string
    defaultCurrency: string
    taxRegime: OnboardingTaxRegime
    pricesIncludeTax: boolean
  }
  showPrimaryTaxId: boolean
  requirePrimaryTaxId: boolean
  primaryTaxIdCopy: OnboardingPrimaryTaxIdCopy
  /** Schemes offered for the primary tax ID. */
  primaryTaxIdSchemes: TaxIdSchemeOption[]
}

const DEFAULT_RULES: OnboardingRules["defaults"] = {
  locale: "en-US",
  timezone: "America/New_York",
  defaultCurrency: "USD",
  taxRegime: "custom",
  pricesIncludeTax: false,
}

const GENERIC_PRIMARY_TAX_ID_COPY: OnboardingPrimaryTaxIdCopy = {
  label: "Tax ID",
  help: "Only needed when your selected tax setup requires it.",
}

function normalizeInvoicingIdentity(
  invoicingIdentity?: string | null
): OnboardingInvoicingIdentity {
  return invoicingIdentity === "individual" ? "individual" : "registered_business"
}

function getDefaults(
  countryCode: string,
  invoicingIdentity: OnboardingInvoicingIdentity
): OnboardingRules["defaults"] {
  const regime = findTaxRegime(countryCode)
  const taxRegime =
    regime && (invoicingIdentity === "registered_business" || regime.appliesToIndividuals)
      ? regime.id
      : "custom"
  const country = findCountryModule(countryCode)
  if (!country) return { ...DEFAULT_RULES, taxRegime }
  return {
    locale: country.defaults.locale,
    timezone: country.defaults.timezone,
    defaultCurrency: country.defaults.currency,
    taxRegime,
    pricesIncludeTax: country.defaults.pricesIncludeTax,
  }
}

function getPrimaryTaxIdCopy(countryCode: string): OnboardingPrimaryTaxIdCopy {
  return (
    findCountryModule(countryCode)?.primaryTaxIdCopy ??
    findTaxRegime(countryCode)?.primaryTaxIdCopy ??
    GENERIC_PRIMARY_TAX_ID_COPY
  )
}

export function getOnboardingRules(input: OnboardingRulesInput): OnboardingRules {
  // No country chosen yet: suggest the US defaults the form starts with.
  const countryCode = normalizeCountryCode(input.countryCode) ?? "US"
  const invoicingIdentity = normalizeInvoicingIdentity(input.invoicingIdentity)
  const defaults = getDefaults(countryCode, invoicingIdentity)
  const taxRegime = (input.taxRegime ?? defaults.taxRegime) as OnboardingTaxRegime
  const showPrimaryTaxId = taxRegime === "eu_vat" && invoicingIdentity === "registered_business"

  return {
    defaults,
    showPrimaryTaxId,
    requirePrimaryTaxId: showPrimaryTaxId,
    primaryTaxIdCopy: getPrimaryTaxIdCopy(countryCode),
    primaryTaxIdSchemes: taxIdSchemeOptions(countryCode),
  }
}
