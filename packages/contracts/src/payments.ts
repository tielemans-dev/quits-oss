import { z } from "zod"
import { invoiceIdSchema, keyVersionSchema, nonEmptyStringSchema } from "./baseSchemas"

export const invoicePaymentStateSchema = z.enum(["unpaid", "paid"])

export const paymentMethodSchema = z.enum(["bank_transfer", "card", "cash", "stripe", "other"])

/** Where a payment record came from: a person, an agent, a Stripe webhook, or the data migration. */
export const paymentSourceSchema = z.enum(["user", "agent", "stripe", "system", "migration"])

/** A positive money amount with at most two decimals. */
export const paymentAmountSchema = z
  .number()
  .positive()
  .max(9_999_999_999.99)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6,
    "Amount can have at most two decimals"
  )

const paymentDateSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "Invalid date")

export const paymentRecordInputSchema = z.object({
  invoiceId: z.string().trim().min(1),
  amount: paymentAmountSchema,
  /** Calendar date (`YYYY-MM-DD`) or ISO timestamp. Must not be in the future. */
  paidAt: paymentDateSchema,
  method: paymentMethodSchema,
  reference: z.string().trim().max(200).optional(),
  note: z.string().trim().max(2000).optional(),
})

export const paymentVoidInputSchema = z.object({
  paymentId: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(500),
})

export const paymentListInputSchema = z.object({
  invoiceId: z.string().trim().min(1),
})
export const invoicePaymentScopeSchema = z.literal("invoice_payment")

export const invoicePaymentTokenPayloadSchema = z
  .object({
    invoiceId: invoiceIdSchema,
    keyVersion: keyVersionSchema,
    scope: invoicePaymentScopeSchema,
  })
  .strict()

export const publicInvoiceTokenInputSchema = z
  .object({
    token: nonEmptyStringSchema,
  })
  .strict()

export const publicInvoiceCheckoutStatusSchema = z.enum([
  "invalid",
  "paid",
  "unavailable",
  "redirect",
])

export const publicInvoiceCheckoutResultSchema = z
  .object({
    url: z.string().url().nullable(),
    status: publicInvoiceCheckoutStatusSchema,
  })
  .strict()

/** The subset of a Stripe Checkout Session that Quits reads from webhooks. */
export const stripeCheckoutSessionSchema = z.object({
  id: z.string().optional(),
  payment_intent: z
    .union([z.string(), z.object({ id: z.string() })])
    .nullable()
    .optional(),
  client_reference_id: z.string().nullable().optional(),
  amount_total: z.number().int().nullable().optional(),
  /**
   * `paid` once the money is collected. Asynchronous methods (bank debits, vouchers) complete
   * checkout as `unpaid` and settle later through `checkout.session.async_payment_*` events.
   */
  payment_status: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
})

export type InvoicePaymentState = z.infer<typeof invoicePaymentStateSchema>
export type InvoicePaymentScope = z.infer<typeof invoicePaymentScopeSchema>
export type InvoicePaymentTokenPayload = z.infer<
  typeof invoicePaymentTokenPayloadSchema
>
export type PublicInvoiceTokenInput = z.infer<typeof publicInvoiceTokenInputSchema>
export type PublicInvoiceCheckoutStatus = z.infer<
  typeof publicInvoiceCheckoutStatusSchema
>
export type PublicInvoiceCheckoutResult = z.infer<
  typeof publicInvoiceCheckoutResultSchema
>
export type PaymentMethod = z.infer<typeof paymentMethodSchema>
export type PaymentSource = z.infer<typeof paymentSourceSchema>
export type PaymentRecordInput = z.infer<typeof paymentRecordInputSchema>
export type PaymentVoidInput = z.infer<typeof paymentVoidInputSchema>
export type PaymentListInput = z.infer<typeof paymentListInputSchema>
export type StripeCheckoutSession = z.infer<typeof stripeCheckoutSessionSchema>
