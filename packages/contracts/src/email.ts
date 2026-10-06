import { z } from "zod"

/**
 * `sending`: delivery was handed to the provider but the outcome was not recorded (for example the
 * process stopped). The document stays frozen until a retry confirms the send.
 */
export const emailDeliveryOutcomeSchema = z.enum(["sent", "skipped", "failed", "sending"])

export const emailDeliveryAttemptRecordSchema = z
  .object({
    lastEmailAttemptAt: z.date(),
    lastEmailAttemptOutcome: emailDeliveryOutcomeSchema,
    lastEmailAttemptCode: z.string().trim().min(1),
    lastEmailAttemptMessage: z.string().trim().min(1),
  })
  .strict()

export const emailDeliveryAttemptSnapshotSchema = z
  .object({
    lastEmailAttemptAt: z.date().nullable(),
    lastEmailAttemptOutcome: emailDeliveryOutcomeSchema.nullable(),
    lastEmailAttemptCode: z.string().trim().min(1).nullable(),
    lastEmailAttemptMessage: z.string().trim().min(1).nullable(),
  })
  .strict()

export const emailDeliveryRuntimeStateSchema = z.enum([
  "configured",
  "missing_configuration",
  "managed",
  "managed_unavailable",
])

export const emailDeliveryRuntimeStatusSchema = z
  .object({
    managed: z.boolean(),
    configured: z.boolean(),
    available: z.boolean(),
    sender: z.string().trim().min(1),
    missing: z.array(z.string().trim().min(1)),
    status: emailDeliveryRuntimeStateSchema,
  })
  .strict()

export type EmailDeliveryOutcome = z.infer<typeof emailDeliveryOutcomeSchema>
export type EmailDeliveryAttemptRecord = z.infer<
  typeof emailDeliveryAttemptRecordSchema
>
export type EmailDeliveryAttemptSnapshot = z.infer<
  typeof emailDeliveryAttemptSnapshotSchema
>
export type EmailDeliveryRuntimeStatus = z.infer<
  typeof emailDeliveryRuntimeStatusSchema
>
