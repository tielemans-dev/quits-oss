import { z } from "zod"

export const calendarDateInputSchema = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "Invalid date")

export const documentLineInputSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().positive().max(1_000_000),
  unitPrice: z.number().min(0).max(1_000_000_000),
})

const currencySchema = z.string().trim().regex(/^[A-Z]{3}$/)

export const invoiceCreateDraftInputSchema = z.object({
  contactId: z.string().trim().min(1),
  dueDate: calendarDateInputSchema,
  currency: currencySchema.optional(),
  notes: z.string().trim().max(5000).optional(),
  taxRate: z.number().min(0).max(100).default(0),
  items: z.array(documentLineInputSchema).min(1).max(100),
})

export const invoiceUpdateDraftInputSchema = z.object({
  id: z.string().min(1),
  contactId: z.string().trim().min(1).optional(),
  dueDate: calendarDateInputSchema.optional(),
  currency: currencySchema.optional(),
  notes: z.string().trim().max(5000).optional(),
  taxRate: z.number().min(0).max(100).optional(),
  items: z.array(documentLineInputSchema).min(1).max(100).optional(),
})

export const invoiceIdInputSchema = z.object({ id: z.string().min(1) })

export const invoiceSendInputSchema = z.object({
  id: z.string().min(1),
  allowSendWithoutEmail: z.boolean().optional(),
})

export const invoiceStatusSchema = z.enum(["draft", "sent", "viewed", "overdue", "paid", "credited"])
export const invoicePaymentProgressSchema = z.enum(["unpaid", "partially_paid", "paid"])

export type DocumentLineInput = z.infer<typeof documentLineInputSchema>
export type InvoiceCreateDraftInput = z.input<typeof invoiceCreateDraftInputSchema>
export type InvoiceUpdateDraftInput = z.infer<typeof invoiceUpdateDraftInputSchema>
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>
export type InvoicePaymentProgress = z.infer<typeof invoicePaymentProgressSchema>
