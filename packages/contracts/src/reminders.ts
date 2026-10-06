import { z } from "zod"

export const REMINDER_OFFSET_MIN_DAYS = -30
export const REMINDER_OFFSET_MAX_DAYS = 90
export const REMINDER_MAX_OFFSETS = 5

/** Days relative to the due date. Negative values remind before the invoice is due. */
export const reminderOffsetDaysSchema = z
  .number()
  .int()
  .min(REMINDER_OFFSET_MIN_DAYS)
  .max(REMINDER_OFFSET_MAX_DAYS)

/**
 * An organization's automatic reminder schedule. Offsets must be unique; they are returned
 * sorted ascending so stored policies have one canonical form.
 */
export const reminderPolicySchema = z.object({
  enabled: z.boolean(),
  offsetsDays: z
    .array(reminderOffsetDaysSchema)
    .max(REMINDER_MAX_OFFSETS)
    .refine((offsets) => new Set(offsets).size === offsets.length, {
      message: "Reminder offsets must be unique",
    })
    .transform((offsets) => [...offsets].sort((a, b) => a - b)),
})

export type ReminderPolicy = z.infer<typeof reminderPolicySchema>

export const DEFAULT_REMINDER_POLICY: ReminderPolicy = {
  enabled: false,
  offsetsDays: [-3, 7, 14],
}

/** Reads a stored policy; anything missing or malformed falls back to the default. */
export function parseReminderPolicy(value: unknown): ReminderPolicy {
  if (value === null || value === undefined) {
    return { ...DEFAULT_REMINDER_POLICY, offsetsDays: [...DEFAULT_REMINDER_POLICY.offsetsDays] }
  }
  const parsed = reminderPolicySchema.safeParse(value)
  return parsed.success
    ? parsed.data
    : { ...DEFAULT_REMINDER_POLICY, offsetsDays: [...DEFAULT_REMINDER_POLICY.offsetsDays] }
}

export const reminderPolicyUpdateInputSchema = reminderPolicySchema

export const invoiceRemindersPausedInputSchema = z.object({
  invoiceId: z.string().min(1),
  paused: z.boolean(),
})

export const reminderSendNowInputSchema = z.object({
  invoiceId: z.string().min(1),
})

export const invoiceRemindersQuerySchema = z.object({
  invoiceId: z.string().min(1),
})

/** Final outcome recorded on a reminder. `failed` means the email provider refused it or never confirmed it. */
export const reminderOutcomeSchema = z.enum(["sent", "failed", "skipped"])

/**
 * How a reminder appears in history: `upcoming` is a policy offset not yet due, `scheduled`
 * is reserved and waiting for its send job.
 */
export const reminderStatusSchema = z.enum(["upcoming", "scheduled", "sent", "failed", "skipped"])

export const invoiceReminderRecordSchema = z.object({
  id: z.string().nullable(),
  offsetDays: z.number().int(),
  scheduledFor: z.date(),
  sentAt: z.date().nullable(),
  status: reminderStatusSchema,
  /** Sent by a person with "Send reminder now" rather than by the schedule. */
  manual: z.boolean(),
  message: z.string().nullable(),
})

export type ReminderOutcome = z.infer<typeof reminderOutcomeSchema>
export type ReminderStatus = z.infer<typeof reminderStatusSchema>
export type InvoiceReminderRecord = z.infer<typeof invoiceReminderRecordSchema>
export type InvoiceRemindersPausedInput = z.infer<typeof invoiceRemindersPausedInputSchema>
export type ReminderSendNowInput = z.infer<typeof reminderSendNowInputSchema>
