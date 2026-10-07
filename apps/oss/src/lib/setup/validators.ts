import { z } from "zod"
import { isCountryCode } from "../compliance/registry"

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const currencyRegex = /^[A-Z]{3}$/

export const instanceProfileSchema = z.enum(["freelancer", "smb", "enterprise"])
export const authModeSchema = z.enum(["local_only", "local_plus_oauth"])

export const setupInitializeSchema = z.object({
  instanceProfile: instanceProfileSchema,
  organization: z.object({
    name: z.string().trim().min(2).max(120),
    slug: z.string().trim().min(2).max(80).regex(slugRegex),
  }),
  admin: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email(),
    password: z.string().min(8).max(128),
  }),
  auth: z.object({
    mode: authModeSchema,
  }),
  locale: z.object({
    locale: z.string().trim().min(2).max(16),
    countryCode: z
      .string()
      .trim()
      .length(2)
      .transform((value) => value.toUpperCase())
      .refine(isCountryCode, "Unknown country"),
    timezone: z.string().trim().min(1).max(120),
    currency: z.string().trim().regex(currencyRegex),
  }),
  email: z
    .object({
      fromName: z.string().trim().min(1).max(120).optional(),
      replyTo: z.string().trim().email().optional(),
    })
    .optional(),
})

export type SetupInitializeInput = z.infer<typeof setupInitializeSchema>
