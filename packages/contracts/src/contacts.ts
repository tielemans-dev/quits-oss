import { z } from "zod"

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
  peppolEndpointId: z.string().trim().max(80).optional(),
  peppolEndpointScheme: z.string().trim().regex(/^\d{4}$/, "Use a 4-digit Peppol EAS code").optional(),
  notes: z.string().trim().max(5000).optional(),
}

export const contactCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  ...contactFields,
})

export const contactUpdateInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  ...contactFields,
})

export const contactDeleteInputSchema = z.object({
  id: z.string().min(1),
})

export type ContactCreateInput = z.infer<typeof contactCreateInputSchema>
export type ContactUpdateInput = z.infer<typeof contactUpdateInputSchema>
