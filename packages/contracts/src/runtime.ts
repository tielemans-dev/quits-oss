import { z } from "zod"

export const aiInvoiceDraftCapabilitiesSchema = z
  .object({
    enabled: z.boolean(),
    byok: z.boolean(),
    managed: z.boolean(),
    managedRequiresSubscription: z.boolean(),
    maxPromptChars: z.number().int().positive(),
  })
  .strict()

export const onboardingAiCapabilitiesSchema = z
  .object({
    enabled: z.boolean(),
    managed: z.boolean(),
  })
  .strict()

export const paymentsCapabilitiesSchema = z
  .object({
    enabled: z.boolean(),
    managed: z.boolean(),
    provider: z.enum(["stripe"]).nullable(),
  })
  .strict()

export const emailDeliveryCapabilitiesSchema = z
  .object({
    enabled: z.boolean(),
    managed: z.boolean(),
  })
  .strict()

export const documentsCapabilitiesSchema = z.object({ artifactsRequired: z.boolean() }).strict()

export const runtimeCapabilitiesSchema = z
  .object({
    documents: documentsCapabilitiesSchema,
    aiInvoiceDraft: aiInvoiceDraftCapabilitiesSchema,
    onboardingAi: onboardingAiCapabilitiesSchema,
    payments: paymentsCapabilitiesSchema,
    emailDelivery: emailDeliveryCapabilitiesSchema,
  })
  .strict()

export const runtimeCapabilityPatchSchema = z
  .object({
    documents: documentsCapabilitiesSchema.partial().optional(),
    aiInvoiceDraft: aiInvoiceDraftCapabilitiesSchema.partial().optional(),
    onboardingAi: onboardingAiCapabilitiesSchema.partial().optional(),
    payments: paymentsCapabilitiesSchema.partial().optional(),
    emailDelivery: emailDeliveryCapabilitiesSchema.partial().optional(),
  })
  .strict()

export type AIInvoiceDraftCapabilities = z.infer<
  typeof aiInvoiceDraftCapabilitiesSchema
>
export type OnboardingAICapabilities = z.infer<
  typeof onboardingAiCapabilitiesSchema
>
export type PaymentsCapabilities = z.infer<typeof paymentsCapabilitiesSchema>
export type EmailDeliveryCapabilities = z.infer<
  typeof emailDeliveryCapabilitiesSchema
>
export type RuntimeCapabilities = z.infer<typeof runtimeCapabilitiesSchema>
export type RuntimeCapabilityPatch = z.infer<typeof runtimeCapabilityPatchSchema>
