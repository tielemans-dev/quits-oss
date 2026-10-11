import { z } from "zod"
import { countryCodeSchema, currencyCodeSchema } from "./baseSchemas"

export { countryCodeSchema, currencyCodeSchema }

export const onboardingInvoicingIdentitySchema = z.enum([
  "individual",
  "registered_business",
])

export const onboardingTaxRegimeSchema = z.enum([
  "us_sales_tax",
  "eu_vat",
  "custom",
])

export const onboardingMissingFieldSchema = z.enum([
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
  "primaryTaxId",
])

export const onboardingPatchSchema = z
  .object({
    companyName: z.string().trim().min(1).max(120).optional(),
    companyAddress: z.string().trim().min(1).max(240).optional(),
    companyEmail: z.string().trim().email().optional(),
    countryCode: countryCodeSchema.optional(),
    invoicingIdentity: onboardingInvoicingIdentitySchema.optional(),
    locale: z.string().trim().min(2).max(16).optional(),
    timezone: z.string().trim().min(1).max(120).optional(),
    defaultCurrency: currencyCodeSchema.optional(),
    taxRegime: onboardingTaxRegimeSchema.optional(),
    pricesIncludeTax: z.boolean().optional(),
    primaryTaxId: z.string().trim().min(1).max(40).optional(),
    primaryTaxIdScheme: z.string().trim().min(1).max(40).optional(),
    invoicePrefix: z.string().trim().regex(/^[A-Z0-9-]{1,10}$/).optional(),
    quotePrefix: z.string().trim().regex(/^[A-Z0-9-]{1,10}$/).optional(),
  })
  .strict()

export const onboardingValuesSchema = z
  .object({
    companyName: z.string().trim().max(120).nullable().optional(),
    companyAddress: z.string().trim().max(240).nullable().optional(),
    companyEmail: z
      .union([z.string().trim().email(), z.literal("")])
      .nullable()
      .transform((value) => (value === "" ? null : value))
      .optional(),
    countryCode: countryCodeSchema.nullable().optional(),
    invoicingIdentity: onboardingInvoicingIdentitySchema.nullable().optional(),
    locale: z.string().trim().min(2).max(16).nullable().optional(),
    timezone: z.string().trim().min(1).max(120).nullable().optional(),
    defaultCurrency: currencyCodeSchema.nullable().optional(),
    taxRegime: onboardingTaxRegimeSchema.nullable().optional(),
    pricesIncludeTax: z.boolean().nullable().optional(),
    invoicePrefix: z
      .string()
      .trim()
      .regex(/^[A-Z0-9-]{1,10}$/)
      .nullable()
      .optional(),
    invoiceNextNum: z.number().int().min(1).nullable().optional(),
    quotePrefix: z
      .string()
      .trim()
      .regex(/^[A-Z0-9-]{1,10}$/)
      .nullable()
      .optional(),
    quoteNextNum: z.number().int().min(1).nullable().optional(),
    primaryTaxId: z.string().trim().max(40).nullable().optional(),
    primaryTaxIdScheme: z.string().trim().max(40).nullable().optional(),
  })
  .strict()

export const onboardingAiSuggestionSchema = z
  .object({
    patch: onboardingPatchSchema,
    rationale: z.string().trim().min(1).max(1000),
    confidence: z.number().min(0).max(1),
    followupQuestions: z.array(z.string().trim().min(1).max(240)).max(10),
  })
  .strict()

export const onboardingApplySourceSchema = z.enum(["ai", "manual"])

export type OnboardingTaxRegime = z.infer<typeof onboardingTaxRegimeSchema>
export type OnboardingInvoicingIdentity = z.infer<
  typeof onboardingInvoicingIdentitySchema
>
export type OnboardingMissingField = z.infer<typeof onboardingMissingFieldSchema>
export type OnboardingPatch = z.infer<typeof onboardingPatchSchema>
export type OnboardingValues = z.infer<typeof onboardingValuesSchema>
export type OnboardingAiSuggestion = z.infer<
  typeof onboardingAiSuggestionSchema
>
export type OnboardingApplySource = z.infer<
  typeof onboardingApplySourceSchema
>

export {
  DANISH_ONBOARDING_V2_DEFAULTS,
  confirmOnboardingV2Schema,
  onboardingV2ConfirmationResultSchema,
  isValidDanishCvr,
} from "./onboarding-v2"
export type { ConfirmOnboardingV2Input, ConfirmOnboardingV2 } from "./onboarding-v2"
