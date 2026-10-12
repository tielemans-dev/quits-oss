import { z } from "zod"

/** Danish CVR checksum, weights 2, 7, 6, 5, 4, 3, 2, 1. */
export function isValidDanishCvr(value: string): boolean {
  return /^\d{8}$/.test(value) && value !== "00000000" &&
    [...value].reduce((sum, digit, index) => sum + Number(digit) * [2, 7, 6, 5, 4, 3, 2, 1][index]!, 0) % 11 === 0
}

export const DANISH_ONBOARDING_V2_DEFAULTS = {
  countryCode: "DK",
  country: "Danmark",
  defaultCurrency: "DKK",
  baseCurrency: "DKK",
  currency: "DKK",
  locale: "da-DK",
  timezone: "Europe/Copenhagen",
  taxRegime: "eu_vat",
  taxRate: 25,
  pricesIncludeTax: false,
  paymentTermsDays: 14,
  // Resolve at use time, including long-running servers across the Danish new year.
  get invoicePrefix() { return new Intl.DateTimeFormat("en", { year: "numeric", timeZone: "Europe/Copenhagen" }).format(new Date()) },
  invoiceNextNum: 1,
  quotePrefix: "QTE",
  quoteNextNum: 1,
} as const

export const confirmOnboardingV2Schema = z.object({
  idempotencyKey: z.string().uuid(),
  companyName: z.string().trim().min(1).max(120),
  companyAddress: z.string().trim().min(1).max(240),
  source: z.enum(["cvr", "manual"]).default("cvr"),
  invoiceNextNum: z.number().int().min(1).max(2147483646).default(1),
  cvr: z.string().trim().refine(isValidDanishCvr, "cvr.invalid"),
  companyForm: z.string().trim().min(1).max(80),
  momsRegistered: z.boolean(),
  vatId: z.string().trim().regex(/^DK\d{8}$/).optional(),
  // Informational client metadata only. Registry contacts are scrubbed server-side.
  reklamebeskyttet: z.boolean().optional(),
  companyEmail: z.string().trim().email().max(254).nullish(),
  companyPhone: z.string().trim().regex(/^(\+45\s?)?\d{8}$/).nullish(),
  // Only invoice-line suggestions the user accepted. Generation belongs to the lookup/UI layer.
  catalogSuggestions: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    defaultUnitPrice: z.number().min(0).max(1_000_000_000),
  }).strict()).max(50).default([]),
  bank: z.object({
    regNumber: z.string().regex(/^\d{4}$/),
    accountNumber: z.string().regex(/^\d{1,10}$/),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.catalogSuggestions.map(item => item.name)).size !== value.catalogSuggestions.length) {
    ctx.addIssue({ code: "custom", path: ["catalogSuggestions"], message: "save.failed" })
  }
  if (value.momsRegistered && value.vatId !== `DK${value.cvr}`) {
    ctx.addIssue({ code: "custom", path: ["vatId"], message: "save.failed" })
  }
  if (!value.momsRegistered && value.vatId !== undefined) {
    ctx.addIssue({ code: "custom", path: ["vatId"], message: "save.failed" })
  }
})

export type ConfirmOnboardingV2Input = z.input<typeof confirmOnboardingV2Schema>
export type ConfirmOnboardingV2 = z.output<typeof confirmOnboardingV2Schema>

/** Stored with the key so retries return the original result even after settings are edited. */
export const onboardingV2ConfirmationResultSchema = z.object({
  status: z.literal("complete"),
  version: z.literal(2),
  completedAt: z.string().datetime(),
  bankMissing: z.boolean(),
}).strict()
