import { z } from "zod"
import { isPeppolEasCode, peppolEndpointIssue } from "./exports"

const peppolEndpointIdSchema = z.string().trim().min(1).max(80)
const peppolEndpointSchemeSchema = z
  .string()
  .trim()
  .refine(isPeppolEasCode, "Use a Peppol EAS code from the Peppol code list, e.g. 0088 or 0184")

const contactFields = {
  email: z.string().trim().email().optional().or(z.literal("")),
  phone: z.string().trim().max(40).optional(),
  company: z.string().trim().max(120).optional(),
  address: z.string().trim().max(240).optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),
  zip: z.string().trim().max(20).optional(),
  country: z.string().trim().max(80).optional(),
  taxId: z.string().trim().max(40).optional(),
  peppolEndpointId: peppolEndpointIdSchema.optional(),
  peppolEndpointScheme: peppolEndpointSchemeSchema.optional(),
  notes: z.string().trim().max(5000).optional(),
}

export const PEPPOL_ENDPOINT_PAIR_MESSAGE = "Enter both the Peppol endpoint ID and its scheme, or neither"
export const PEPPOL_ENDPOINT_ID_MESSAGE = "This endpoint ID does not match the Peppol scheme"

type PeppolEndpointValue = { peppolEndpointId?: string | null; peppolEndpointScheme?: string | null }

/**
 * Checks a Peppol endpoint pair. With `partial`, a missing side means "keep the stored value", so
 * only pairs given together are checked here; the update command checks the merged result.
 */
function peppolEndpointCheck(options: { partial: boolean }) {
  return (value: PeppolEndpointValue, ctx: z.RefinementCtx) => {
    const { peppolEndpointId: id, peppolEndpointScheme: scheme } = value
    if (options.partial && (id === undefined || scheme === undefined)) return
    const hasId = typeof id === "string" && id.length > 0
    const hasScheme = typeof scheme === "string" && scheme.length > 0
    if (hasId !== hasScheme) {
      ctx.addIssue({
        code: "custom",
        message: PEPPOL_ENDPOINT_PAIR_MESSAGE,
        path: [hasId ? "peppolEndpointScheme" : "peppolEndpointId"],
      })
      return
    }
    if (hasId && hasScheme && peppolEndpointIssue(scheme, id) === "id") {
      ctx.addIssue({ code: "custom", message: PEPPOL_ENDPOINT_ID_MESSAGE, path: ["peppolEndpointId"] })
    }
  }
}

export const contactCreateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    ...contactFields,
  })
  .superRefine(peppolEndpointCheck({ partial: false }))

export const contactUpdateInputSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1).max(120).optional(),
    ...contactFields,
    /** `null` clears the stored endpoint; omit to leave it unchanged. */
    peppolEndpointId: peppolEndpointIdSchema.nullable().optional(),
    peppolEndpointScheme: peppolEndpointSchemeSchema.nullable().optional(),
  })
  .superRefine(peppolEndpointCheck({ partial: true }))

export const contactDeleteInputSchema = z.object({
  id: z.string().min(1),
})

export type ContactCreateInput = z.infer<typeof contactCreateInputSchema>
export type ContactUpdateInput = z.infer<typeof contactUpdateInputSchema>
