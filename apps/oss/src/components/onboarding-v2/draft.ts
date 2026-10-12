import { z } from "zod"
import { DANISH_ONBOARDING_V2_DEFAULTS } from "@quits/contracts/onboarding"
import {
  cvrCompanySchema,
  onboardingSuggestionsSchema,
  type CvrCompany,
} from "@quits/contracts/cvr"

export const reviewValuesSchema = z.object({
  companyName: z.string().max(120),
  companyAddress: z.string().max(240),
  cvr: z.string().max(8),
  companyForm: z.string().max(80),
  companyEmail: z.string().max(254),
  companyPhone: z.string().max(30),
  momsRegistered: z.boolean(),
  countryCode: z.string().length(2),
  defaultCurrency: z.string().max(3),
  locale: z.string().max(20),
  timezone: z.string().max(120),
  taxRate: z.number().finite(),
  pricesIncludeTax: z.boolean(),
  invoicePrefix: z.string().max(10),
  invoiceNextNum: z.number().finite(),
  paymentTermsDays: z.number().finite(),
  bankRegNumber: z.string().max(4),
  bankAccountNumber: z.string().max(10),
})
export type ReviewValues = z.infer<typeof reviewValuesSchema>
export const draftSchema = z.object({
  version: z.literal(2),
  idempotencyKey: z.string().uuid(),
  source: z.enum(["cvr", "manual"]),
  values: reviewValuesSchema,
  company: cvrCompanySchema.nullable(),
  suggestions: onboardingSuggestionsSchema.nullable(),
  suggestionsState: z.enum(["pending", "ready", "hidden"]),
})
export type OnboardingDraft = z.infer<typeof draftSchema>

export function newDraft(
  company: CvrCompany | null,
  email: string,
  suggestions: boolean,
): OnboardingDraft {
  return {
    version: 2,
    idempotencyKey: crypto.randomUUID(),
    source: company ? "cvr" : "manual",
    company,
    suggestions: null,
    suggestionsState: company && suggestions ? "pending" : "hidden",
    values: {
      companyName: company?.name ?? "",
      companyAddress: company?.address ?? "",
      cvr: company?.cvr ?? "",
      companyForm: company?.companyForm ?? "ApS",
      companyEmail: company?.advertisingProtected ? email : (company?.email ?? email),
      companyPhone: company?.advertisingProtected ? "" : (company?.phone ?? ""),
      momsRegistered: company?.momsRegistered ?? true,
      countryCode: "DK",
      defaultCurrency: "DKK",
      locale: "da-DK",
      timezone: "Europe/Copenhagen",
      taxRate: company?.momsRegistered === false ? 0 : 25,
      pricesIncludeTax: false,
      invoicePrefix: DANISH_ONBOARDING_V2_DEFAULTS.invoicePrefix,
      invoiceNextNum: 1,
      paymentTermsDays: 14,
      bankRegNumber: "",
      bankAccountNumber: "",
    },
  }
}

export function draftKey(userId: string, organizationId: string) {
  return `quits:onboarding:v2:${encodeURIComponent(userId)}:${encodeURIComponent(organizationId)}`
}
export function restoreDraft(key: string): OnboardingDraft | null {
  try {
    const value = sessionStorage.getItem(key)
    if (!value) return null
    const parsed = draftSchema.safeParse(JSON.parse(value))
    if (parsed.success) return parsed.data
    sessionStorage.removeItem(key)
  } catch {
    /* Restricted storage must not block setup. */
  }
  return null
}
export function storeDraft(key: string, draft: OnboardingDraft) {
  try {
    sessionStorage.setItem(key, JSON.stringify(draft))
  } catch {
    /* Keep the in-memory draft. */
  }
}
export function clearDraft(key: string) {
  try {
    sessionStorage.removeItem(key)
  } catch {
    /* Restricted browser storage. */
  }
}

export function confirmationPayload(draft: OnboardingDraft) {
  const v = draft.values
  return {
    idempotencyKey: draft.idempotencyKey,
    source: draft.source,
    companyName: v.companyName,
    companyAddress: v.companyAddress,
    cvr: v.cvr,
    companyForm: v.companyForm,
    momsRegistered: v.momsRegistered,
    ...(v.momsRegistered && v.cvr ? { vatId: `DK${v.cvr}` } : {}),
    companyEmail: v.companyEmail || undefined,
    companyPhone: v.companyPhone || undefined,
    invoiceNextNum: v.invoiceNextNum,
    ...(v.bankRegNumber || v.bankAccountNumber
      ? { bank: { regNumber: v.bankRegNumber, accountNumber: v.bankAccountNumber } }
      : {}),
    settings: {
      countryCode: v.countryCode,
      defaultCurrency: v.defaultCurrency,
      locale: v.locale,
      timezone: v.timezone,
      taxRate: v.momsRegistered ? v.taxRate : 0,
      pricesIncludeTax: v.pricesIncludeTax,
      invoicePrefix: v.invoicePrefix,
      paymentTermsDays: v.paymentTermsDays,
    },
    ...(draft.suggestionsState === "ready" && draft.suggestions
      ? {
          catalogSuggestions: draft.suggestions.lines.map((line) => ({
            name: line.description.slice(0, 120),
            description: line.description,
            defaultUnitPrice: line.unitPrice,
          })),
        }
      : {}),
  }
}
