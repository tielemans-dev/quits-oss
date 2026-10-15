import { z } from "zod"

/** Mapped public invoicing facts only. Never include the registry's raw response. */
export const cvrCompanySchema = z
  .object({
    cvr: z.string().regex(/^\d{8}$/),
    name: z.string().min(1).max(120),
    address: z.string().max(240),
    companyForm: z.string().max(80),
    industry: z.string().max(160).optional(),
    status: z.enum([
      "active",
      "ceased",
      "dissolved",
      "bankrupt",
      "liquidation",
      "bankruptcy_proceedings",
      "reconstruction",
      "compulsory_dissolution",
    ]),
    statusClass: z.enum(["active", "warn", "blocked"]),
    statusDate: z.string().optional(),
    /** null: the registry did not say. Onboarding must ask the user, never assume. */
    momsRegistered: z.boolean().nullable(),
    email: z.string().email().nullish(),
    phone: z.string().nullish(),
    advertisingProtected: z.boolean().optional(),
  })
  .strict()

export const onboardingSuggestionsSchema = z
  .object({
    customers: z
      .array(z.object({ id: z.string().max(80), label: z.string().min(1).max(160) }).strict())
      .max(8),
    lines: z
      .array(
        z
          .object({
            id: z.string().max(80),
            description: z.string().min(1).max(240),
            unitPrice: z.number().min(0).max(1e9),
            unit: z.enum(["hour", "each"]),
          })
          .strict(),
      )
      .max(8),
  })
  .strict()

export type CvrCompany = z.infer<typeof cvrCompanySchema>
export type OnboardingSuggestions = z.infer<typeof onboardingSuggestionsSchema>
