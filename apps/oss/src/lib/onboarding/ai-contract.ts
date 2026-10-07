import {
  onboardingAiSuggestionSchema,
  onboardingPatchSchema,
  onboardingTaxRegimeSchema,
  type OnboardingAiSuggestion,
  type OnboardingMissingField,
  type OnboardingPatch,
  type OnboardingTaxRegime,
} from "@quits/contracts/onboarding"
import { getOnboardingRules } from "./rules"

export {
  onboardingAiSuggestionSchema,
  onboardingPatchSchema,
  onboardingTaxRegimeSchema,
}
export type {
  OnboardingAiSuggestion,
  OnboardingMissingField,
  OnboardingPatch,
  OnboardingTaxRegime,
}

export type OnboardingRequirementRules = {
  requiredFields: OnboardingMissingField[]
  optionalFields: OnboardingMissingField[]
  fieldRules: Partial<Record<OnboardingMissingField, string>>
}

export type OnboardingFollowupQuestion = {
  id: string
  question: string
  fieldHint: OnboardingMissingField
}

const REQUIRED_BASE_FIELDS: OnboardingMissingField[] = [
  "companyName",
  "companyAddress",
  "companyEmail",
  "countryCode",
  "locale",
  "timezone",
  "defaultCurrency",
  "taxRegime",
  "invoicePrefix",
  "invoiceNextNum",
  "quotePrefix",
  "quoteNextNum",
]

const FIELD_QUESTIONS: Record<OnboardingMissingField, string> = {
  companyName: "What is the legal company name that should appear on invoices?",
  companyAddress: "What company address should be printed on invoices?",
  companyEmail: "Which billing email should receive invoice communication?",
  countryCode: "Which country does this organization primarily operate in?",
  locale: "Which locale should be used for dates and number formatting?",
  timezone: "Which timezone should invoice issue dates use?",
  defaultCurrency: "What default currency should invoices use?",
  taxRegime: "Which tax regime should be applied by default?",
  invoicePrefix: "What prefix should be used for invoice numbering?",
  invoiceNextNum: "What should the next invoice number start from?",
  quotePrefix: "What prefix should be used for quote numbering?",
  quoteNextNum: "What should the next quote number start from?",
  primaryTaxId: "What is the primary tax ID or VAT number for the organization?",
}

export function getRequirementRules(input: {
  countryCode?: string | null
  invoicingIdentity?: string | null
  taxRegime?: OnboardingTaxRegime | string | null
}): OnboardingRequirementRules {
  const rules = getOnboardingRules(input)
  const requiredFields: OnboardingMissingField[] = rules.requirePrimaryTaxId
    ? [...REQUIRED_BASE_FIELDS, "primaryTaxId"]
    : [...REQUIRED_BASE_FIELDS]

  return {
    requiredFields,
    optionalFields: [],
    fieldRules: {
      companyEmail: "Must be a valid email address.",
      countryCode: "Use ISO-3166 alpha-2 country code (for example DK, US).",
      defaultCurrency: "Use ISO-4217 currency code (for example USD, EUR).",
      taxRegime: "Allowed values: us_sales_tax, eu_vat, custom.",
      invoicePrefix: "Uppercase letters/numbers/hyphen, max 10 chars.",
      quotePrefix: "Uppercase letters/numbers/hyphen, max 10 chars.",
      primaryTaxId: rules.requirePrimaryTaxId
        ? rules.primaryTaxIdCopy.help
        : "Optional unless local policy requires it.",
    },
  }
}

export function listFollowupQuestions(
  missing: readonly OnboardingMissingField[]
): OnboardingFollowupQuestion[] {
  return missing.map((field) => ({
    id: `missing-${field}`,
    fieldHint: field,
    question: FIELD_QUESTIONS[field],
  }))
}
