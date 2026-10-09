import { z } from "zod"

export const journalDocumentInputSchema = z.object({
  documentType: z.enum(["invoice", "quote", "creditNote", "agreement"]),
  documentId: z.string().trim().min(1).max(100)
})
export const journalDeliveryInputSchema = journalDocumentInputSchema.extend({
  deliveryId: z.string().trim().min(1).max(100)
})
export const journalManualResendInputSchema = journalDeliveryInputSchema.extend(
  {
    mode: z.enum(["stored", "replacement"]).default("stored"),
    reviewedTarget: z.object({
      revision: z.string().min(1).max(100),
      recipient: z.string().email(),
      publicLinkKeyVersion: z.string().min(1).max(100).nullable()
    }),
    reason: z.string().trim().min(1).max(1000),
    acknowledgeDuplicateRisk: z.literal(true),
    clientRequestId: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/)
  }
)

export type JournalDocumentInput = z.infer<typeof journalDocumentInputSchema>
export type JournalDeliveryInput = z.infer<typeof journalDeliveryInputSchema>
export type JournalManualResendInput = z.infer<
  typeof journalManualResendInputSchema
>
export type JournalStepState =
  | "queued"
  | "waiting_prerequisite"
  | "effects_completed"
  | "delivery_confirmed"
  | "failed_step"
  | "uncertain"
