import { z } from "zod"
import { documentLineInputSchema } from "./invoices"

/** A calendar date without time or timezone, e.g. `2026-01-31`. */
export const recurringCalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`)
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
  }, "Invalid date")

export const recurringIntervalUnitSchema = z.enum(["week", "month", "year"])
export const recurringStatusSchema = z.enum(["active", "paused", "ended"])

/** When a schedule stops generating invoices. */
export const recurringEndSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("on_date"), endsAt: recurringCalendarDateSchema }),
  z.object({ type: z.literal("after_runs"), runs: z.number().int().min(1).max(1000) }),
])

const currencySchema = z.string().trim().regex(/^[A-Z]{3}$/)

const scheduleFields = {
  name: z.string().trim().min(1).max(200),
  contactId: z.string().trim().min(1),
  items: z.array(documentLineInputSchema).min(1).max(100),
  taxRate: z.number().min(0).max(100),
  currency: currencySchema,
  notes: z.string().trim().max(5000),
  intervalCount: z.number().int().min(1).max(12),
  intervalUnit: recurringIntervalUnitSchema,
  startDate: recurringCalendarDateSchema,
  dueInDays: z.number().int().min(0).max(120),
  autoSend: z.boolean(),
  end: recurringEndSchema,
}

export const recurringCreateInputSchema = z.object({
  name: scheduleFields.name,
  contactId: scheduleFields.contactId,
  items: scheduleFields.items,
  taxRate: scheduleFields.taxRate.default(0),
  currency: scheduleFields.currency.optional(),
  notes: scheduleFields.notes.optional(),
  intervalCount: scheduleFields.intervalCount.default(1),
  intervalUnit: scheduleFields.intervalUnit.default("month"),
  startDate: scheduleFields.startDate,
  dueInDays: scheduleFields.dueInDays.default(14),
  autoSend: scheduleFields.autoSend.default(false),
  end: scheduleFields.end.default({ type: "none" }),
})

/** Every field except `id` is optional; omitted fields keep their current value. */
export const recurringUpdateInputSchema = z.object({
  id: z.string().min(1),
  name: scheduleFields.name.optional(),
  contactId: scheduleFields.contactId.optional(),
  items: scheduleFields.items.optional(),
  taxRate: scheduleFields.taxRate.optional(),
  currency: scheduleFields.currency.optional(),
  notes: scheduleFields.notes.nullable().optional(),
  intervalCount: scheduleFields.intervalCount.optional(),
  intervalUnit: scheduleFields.intervalUnit.optional(),
  startDate: scheduleFields.startDate.optional(),
  dueInDays: scheduleFields.dueInDays.optional(),
  autoSend: scheduleFields.autoSend.optional(),
  end: scheduleFields.end.optional(),
})

export const recurringIdInputSchema = z.object({ id: z.string().min(1) })

/** Pausing and ending; resuming is a separate command because it can be outward-facing. */
export const recurringSetStatusInputSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["paused", "ended"]),
})

export const recurringItemsSchema = z.array(documentLineInputSchema)

export type RecurringIntervalUnit = z.infer<typeof recurringIntervalUnitSchema>
export type RecurringStatus = z.infer<typeof recurringStatusSchema>
export type RecurringEnd = z.infer<typeof recurringEndSchema>
export type RecurringCreateInput = z.input<typeof recurringCreateInputSchema>
export type RecurringUpdateInput = z.infer<typeof recurringUpdateInputSchema>
export type RecurringSetStatusInput = z.infer<typeof recurringSetStatusInputSchema>
