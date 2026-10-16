import { z } from "zod"

export const aiInvoiceDraftCapabilitiesSchema = z
  .object({
    enabled: z.boolean(),
    byok: z.boolean(),
    managed: z.boolean(),
    managedRequiresSubscription: z.boolean(),
    /** Organisations may point the OpenAI-compatible provider at their own base URL. */
    customEndpoint: z.boolean(),
    /** The server may run a locally installed CLI agent configured by the operator. */
    localAgent: z.boolean(),
    /** Optional model fills for command-bar requests; disabled unless explicitly enabled. */
    requestFallbackEnabled: z.boolean().optional(),
    /** A decision model reads palette text the parser cannot; on when the operator sets its key. */
    requestDecisionsEnabled: z.boolean().optional(),
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

export const agreementCapabilitiesSchema = z.object({ depositsEnabled: z.boolean() }).strict()

export const runtimeCapabilitiesSchema = z
  .object({
    documents: documentsCapabilitiesSchema,
    agreements: agreementCapabilitiesSchema.default({ depositsEnabled: true }),
    aiInvoiceDraft: aiInvoiceDraftCapabilitiesSchema,
    onboardingAi: onboardingAiCapabilitiesSchema,
    onboardingV2: z.object({ enabled: z.boolean(), nonVatEnabled: z.boolean().optional() }).strict().optional(),
    sellerVatConfirmation: z.object({ enabled: z.boolean() }).strict().default({ enabled: false }),
    payments: paymentsCapabilitiesSchema,
    emailDelivery: emailDeliveryCapabilitiesSchema,
  })
  .strict()

export const runtimeCapabilityPatchSchema = z
  .object({
    documents: documentsCapabilitiesSchema.partial().optional(),
    agreements: agreementCapabilitiesSchema.partial().optional(),
    aiInvoiceDraft: aiInvoiceDraftCapabilitiesSchema.partial().optional(),
    onboardingAi: onboardingAiCapabilitiesSchema.partial().optional(),
    onboardingV2: z.object({ enabled: z.boolean().optional(), nonVatEnabled: z.boolean().optional() }).strict().optional(),
    sellerVatConfirmation: z.object({ enabled: z.boolean().optional() }).strict().optional(),
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
