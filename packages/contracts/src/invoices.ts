import { z } from "zod"
import { quantityInputSchema, unitPriceInputSchema } from "./pricing"
import { nonnegativeDecimalStringSchema, vatTreatmentSchema, vatReasonCodeSchema, draftVatEvidenceSchema } from "./vat"
import { countryCodeSchema } from "./baseSchemas"

export const quantityDecimalSchema = quantityInputSchema.refine((value) => Number(value) > 0 && Number(value) <= 1_000_000)
export const unitPriceDecimalSchema = unitPriceInputSchema.refine((value) => Number(value) <= 1_000_000_000)
export const documentTaxRateSchema = z.union([z.number().min(0).max(100), nonnegativeDecimalStringSchema.refine((value) => Number(value) <= 100)])
export const documentTaxRateV2Schema = nonnegativeDecimalStringSchema.refine((value) => Number(value) <= 100)
// Drafts may lack evidence and reason codes. The issuance validator enforces their completeness.
export const documentVatInputSchema = z.strictObject({
  treatment: vatTreatmentSchema,
  rate: nonnegativeDecimalStringSchema.optional(),
  country: countryCodeSchema.nullable().optional(),
  reasonCode: vatReasonCodeSchema.nullable().optional(),
})

export const calendarDateInputSchema = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "Invalid date")

export const documentLineInputSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.union([z.number().positive().max(1_000_000), quantityDecimalSchema]),
  unitPrice: z.union([z.number().min(0).max(1_000_000_000), unitPriceDecimalSchema]),
  vat: documentVatInputSchema.optional(),
})

export const documentLineV2InputSchema = documentLineInputSchema.extend({
  quantity: quantityDecimalSchema,
  unitPrice: unitPriceDecimalSchema,
})

export const invoiceUpdateLineInputSchema = documentLineInputSchema.extend({
  id: z.string().min(1).optional(),
  deliverableId: z.string().min(1).optional(),
})
export const invoiceUpdateLineV2InputSchema = invoiceUpdateLineInputSchema.extend({
  quantity: quantityDecimalSchema,
  unitPrice: unitPriceDecimalSchema,
})

const currencySchema = z.string().trim().regex(/^[A-Z]{3}$/)

export const invoiceCreateDraftInputSchema = z.object({
  contactId: z.string().trim().min(1),
  dueDate: calendarDateInputSchema,
  currency: currencySchema.optional(),
  notes: z.string().trim().max(5000).optional(),
  taxRate: documentTaxRateSchema.default(0),
  vatEvidence: draftVatEvidenceSchema.optional(),
  items: z.array(documentLineInputSchema).min(1).max(100),
})

export const invoiceUpdateDraftInputSchema = z.object({
  id: z.string().min(1),
  contactId: z.string().trim().min(1).optional(),
  dueDate: calendarDateInputSchema.optional(),
  currency: currencySchema.optional(),
  notes: z.string().trim().max(5000).optional(),
  taxRate: documentTaxRateSchema.optional(),
  vatEvidence: draftVatEvidenceSchema.optional(),
  items: z.array(invoiceUpdateLineInputSchema).min(1).max(100).optional(),
})

export const invoiceCreateDraftV2InputSchema = invoiceCreateDraftInputSchema.extend({
  taxRate: documentTaxRateV2Schema.default("0"),
  items: z.array(documentLineV2InputSchema).min(1).max(100),
})
export const invoiceUpdateDraftV2InputSchema = invoiceUpdateDraftInputSchema.extend({
  taxRate: documentTaxRateV2Schema.optional(),
  items: z.array(invoiceUpdateLineV2InputSchema).min(1).max(100).optional(),
})

export const invoiceIdInputSchema = z.object({ id: z.string().min(1) })

export const invoiceSendInputSchema = z.object({
  id: z.string().min(1),
  allowSendWithoutEmail: z.boolean().optional(),
})

export const invoiceStatusSchema = z.enum(["draft", "sent", "viewed", "overdue", "paid", "credited"])
export const invoicePaymentProgressSchema = z.enum(["unpaid", "partially_paid", "paid"])

export type DocumentLineInput = z.infer<typeof documentLineInputSchema> & { inputPrecision?: "number" | "string" | "backfilled" }
export type InvoiceCreateDraftInput = z.input<typeof invoiceCreateDraftInputSchema>
export type InvoiceUpdateDraftInput = z.infer<typeof invoiceUpdateDraftInputSchema>
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>
export type InvoicePaymentProgress = z.infer<typeof invoicePaymentProgressSchema>

export const invoiceCreateFromDeliverablesInputSchema = z.strictObject({
  agreementId: z.string().min(1),
  deliverableIds: z.array(z.string().min(1)).min(1).max(100),
  issueDate: calendarDateInputSchema.optional(),
  dueDate: calendarDateInputSchema.optional(),
  // The explicit choice is recorded on the sale draft and the reservation event.
  scheduleAsSale: z.boolean().optional(),
})
export const invoiceAddDeliverablesInputSchema = invoiceCreateFromDeliverablesInputSchema.omit({ issueDate: true, dueDate: true }).extend({ id: z.string().min(1) })
