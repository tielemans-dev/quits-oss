import { z } from "zod"
import { invoiceIdSchema, keyVersionSchema, nonEmptyStringSchema } from "./baseSchemas"

export const invoicePaymentStateSchema = z.enum(["unpaid", "paid"])
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

/** The subset of a Stripe Checkout Session that YAIP reads from webhooks. */
export const stripeCheckoutSessionSchema = z.object({
  id: z.string().optional(),
  payment_intent: z
    .union([z.string(), z.object({ id: z.string() })])
    .nullable()
    .optional(),
  client_reference_id: z.string().nullable().optional(),
  amount_total: z.number().int().nullable().optional(),
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
export type StripeCheckoutSession = z.infer<typeof stripeCheckoutSessionSchema>
