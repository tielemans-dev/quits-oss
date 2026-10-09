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

const dateInputSchema = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "Invalid date")

/** Keep datetime clients compatible, but store the calendar day they wrote, not their instant. */
export const calendarDateInputSchema = dateInputSchema
  .transform(value => /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : new Date(value).toISOString().slice(0, 10))
  .pipe(z.iso.date())

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
  supplyDate: calendarDateInputSchema.optional(),
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
  supplyDate: calendarDateInputSchema.optional(),
  currency: currencySchema.optional(),
  notes: z.string().trim().max(5000).optional(),
  taxRate: documentTaxRateSchema.optional(),
  vatEvidence: draftVatEvidenceSchema.optional(),
  items: z.array(invoiceUpdateLineInputSchema).min(1).max(100).optional(),
})

export const invoiceCreateDraftV2InputSchema = invoiceCreateDraftInputSchema.extend({
  supplyDate: calendarDateInputSchema,
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
  acknowledgeDisputed: z.boolean().optional(),
  supplyDate: calendarDateInputSchema.optional(),
  exchangeRate: z.string().max(40).regex(/^\d+(?:\.\d{1,12})?$/).refine(value => /[1-9]/.test(value)).optional(),
  rateDate: calendarDateInputSchema.optional(),
  vatReporting: z.strictObject({ rate: nonnegativeDecimalStringSchema, rateSource: z.string().min(1), taxBaseForReturn: nonnegativeDecimalStringSchema, taxForReturn: nonnegativeDecimalStringSchema }).optional(),
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
  issueDate: dateInputSchema.optional(),
  dueDate: calendarDateInputSchema.optional(),
  // The explicit choice is recorded on the sale draft and the reservation event.
  scheduleAsSale: z.boolean().optional(),
})
export const invoiceAddDeliverablesInputSchema = invoiceCreateFromDeliverablesInputSchema.omit({ issueDate: true, dueDate: true }).extend({ id: z.string().min(1) })

/** One request ID per user intent; retain it when retrying an uncertain response. */
export const invoiceMarkPaidInputSchema = z.object({
  invoiceId: z.string().trim().min(1),
  requestId: z.string().trim().min(1).max(100),
}).strict()
export const invoiceUndoMarkPaidInputSchema = invoiceMarkPaidInputSchema.extend({
  paymentId: z.string().trim().min(1),
}).strict()

/** Exact major units, with the invoice currency. No floating-point money crosses this API. */
export const invoicePaidMomentMoneySchema = z.object({
  amount: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,2})?$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict()
export const invoicePaidMomentResultSchema = z.object({
  paymentId: z.string().min(1),
  invoiceStatus: invoiceStatusSchema,
  balance: invoicePaidMomentMoneySchema,
  total: invoicePaidMomentMoneySchema,
  /** Decimal string: clamp((total - balance) / total, 0, 1), including credits. */
  paidFraction: z.string().regex(/^(0(\.\d+)?|1(\.0+)?)$/),
  /** Original deadline, also returned after undo. Undo does not renew the window. */
  undoUntil: z.iso.datetime(),
}).strict()
export type InvoiceMarkPaidInput = z.infer<typeof invoiceMarkPaidInputSchema>
export type InvoiceUndoMarkPaidInput = z.infer<typeof invoiceUndoMarkPaidInputSchema>
export type InvoicePaidMomentResult = z.infer<typeof invoicePaidMomentResultSchema>
