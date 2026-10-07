import type { OnboardingTaxRegime } from "@quits/contracts/onboarding"

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
}

const DEFAULT_RULES: OnboardingRules["defaults"] = {
  locale: "en-US",
  timezone: "America/New_York",
  defaultCurrency: "USD",
  taxRegime: "us_sales_tax",
  pricesIncludeTax: false,
}

const EU_COUNTRIES = new Set(["DK", "DE", "FR", "NL"])

function normalizeCountryCode(countryCode?: string | null) {
  return countryCode?.trim().toUpperCase() || "US"
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
  if (countryCode === "DK") {
    return {
      locale: "da-DK",
      timezone: "Europe/Copenhagen",
      defaultCurrency: "DKK",
      taxRegime: invoicingIdentity === "registered_business" ? "eu_vat" : "custom",
      pricesIncludeTax: true,
    }
  }

  if (countryCode === "DE") {
    return {
      locale: "de-DE",
      timezone: "Europe/Berlin",
      defaultCurrency: "EUR",
      taxRegime: invoicingIdentity === "registered_business" ? "eu_vat" : "custom",
      pricesIncludeTax: true,
    }
  }

  if (countryCode === "FR") {
    return {
      locale: "fr-FR",
      timezone: "Europe/Paris",
      defaultCurrency: "EUR",
      taxRegime: invoicingIdentity === "registered_business" ? "eu_vat" : "custom",
      pricesIncludeTax: true,
    }
  }

  if (countryCode === "NL") {
    return {
      locale: "nl-NL",
      timezone: "Europe/Amsterdam",
      defaultCurrency: "EUR",
      taxRegime: invoicingIdentity === "registered_business" ? "eu_vat" : "custom",
      pricesIncludeTax: true,
    }
  }

  return DEFAULT_RULES
}

function getPrimaryTaxIdCopy(countryCode: string): OnboardingPrimaryTaxIdCopy {
  if (countryCode === "DK") {
    return {
      label: "VAT/CVR number",
      help: "Required for Danish registered businesses using EU VAT.",
    }
  }

  if (EU_COUNTRIES.has(countryCode)) {
    return {
      label: "VAT number",
      help: "Required for registered businesses using EU VAT.",
    }
  }

  return {
    label: "Tax ID",
    help: "Only needed when your selected tax setup requires it.",
  }
}

export function getOnboardingRules(input: OnboardingRulesInput): OnboardingRules {
  const countryCode = normalizeCountryCode(input.countryCode)
  const invoicingIdentity = normalizeInvoicingIdentity(input.invoicingIdentity)
  const defaults = getDefaults(countryCode, invoicingIdentity)
  const taxRegime = (input.taxRegime ?? defaults.taxRegime) as OnboardingTaxRegime
  const showPrimaryTaxId = taxRegime === "eu_vat" && invoicingIdentity === "registered_business"

  return {
    defaults,
    showPrimaryTaxId,
    requirePrimaryTaxId: showPrimaryTaxId,
    primaryTaxIdCopy: getPrimaryTaxIdCopy(countryCode),
  }
}
