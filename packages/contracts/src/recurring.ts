import { z } from "zod"
import { calendarDateInputSchema, documentLineInputSchema, documentLineV2InputSchema, refineDocumentLineKeys, documentTaxRateSchema, documentTaxRateV2Schema } from "./invoices"

import { draftVatEvidenceSchema } from "./vat"

/** Calendar day, also accepting datetime clients without retaining their time or offset. */
export const recurringCalendarDateSchema = calendarDateInputSchema

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
  items: z.array(documentLineInputSchema).min(1).max(100).superRefine(refineDocumentLineKeys),
  taxRate: documentTaxRateSchema,
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
  vatEvidence: draftVatEvidenceSchema.optional(),
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
  vatEvidence: draftVatEvidenceSchema.optional(),
  currency: scheduleFields.currency.optional(),
  notes: scheduleFields.notes.nullable().optional(),
  intervalCount: scheduleFields.intervalCount.optional(),
  intervalUnit: scheduleFields.intervalUnit.optional(),
  startDate: scheduleFields.startDate.optional(),
  dueInDays: scheduleFields.dueInDays.optional(),
  autoSend: scheduleFields.autoSend.optional(),
  end: scheduleFields.end.optional(),
})

export const recurringCreateV2InputSchema = recurringCreateInputSchema.extend({
  taxRate: documentTaxRateV2Schema.default("0"),
  items: z.array(documentLineV2InputSchema).min(1).max(100).superRefine(refineDocumentLineKeys),
})
export const recurringUpdateV2InputSchema = recurringUpdateInputSchema.extend({
  taxRate: documentTaxRateV2Schema.optional(),
  items: z.array(documentLineV2InputSchema).min(1).max(100).superRefine(refineDocumentLineKeys).optional(),
})

export const recurringIdInputSchema = z.object({ id: z.string().min(1) })

/** Pausing and ending; resuming is a separate command because it can be outward-facing. */
export const recurringSetStatusInputSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["paused", "ended"]),
})

export const recurringItemsSchema = scheduleFields.items

export type RecurringIntervalUnit = z.infer<typeof recurringIntervalUnitSchema>
export type RecurringStatus = z.infer<typeof recurringStatusSchema>
export type RecurringEnd = z.infer<typeof recurringEndSchema>
export type RecurringCreateInput = z.input<typeof recurringCreateInputSchema>
export type RecurringUpdateInput = z.infer<typeof recurringUpdateInputSchema>
export type RecurringSetStatusInput = z.infer<typeof recurringSetStatusInputSchema>
