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

/** Settlement commands use exact major-unit strings; unsupported currency precision is refused. */
export const settlementAmountSchema = z.string().regex(/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/)
export const settlementEvidenceSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  evidence: z.string()
    // Check the submitted text before trimming or URL parsing can discard controls.
    .refine(value => ![...value].some(character => {
      const code = character.charCodeAt(0)
      return code < 32 || (code >= 127 && code <= 159)
    }), "Evidence links must not contain control characters")
    .trim().url().max(2000)
    .refine(value => /^https?:\/\//.test(value), "Use an HTTP or HTTPS evidence link")
    .refine(value => {
      try {
        const url = new URL(value)
        return !url.username && !url.password
      } catch {
        return false
      }
    }, "Evidence links must not contain a username or password"),
}).strict()
const settlementRequest = { requestId: z.string().trim().min(1).max(100) }
export const receiptRecordInputSchema = z.object({
  ...settlementRequest,
  contactId: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  netAmount: settlementAmountSchema,
  feeAmount: settlementAmountSchema.default("0"),
  paidAt: paymentDateSchema,
  method: paymentMethodSchema,
  reference: z.string().trim().min(1).max(200),
  ...settlementEvidenceSchema.shape,
  feeEvidence: settlementEvidenceSchema.optional(),
}).strict()
export const receiptAllocateInputSchema = z.object({
  ...settlementRequest,
  receiptId: z.string().min(1),
  allocations: z.array(z.object({
    invoiceId: z.string().min(1),
    /** Quantity consumed in receipt currency. */
    receiptAmount: settlementAmountSchema,
    /** Debt discharged in invoice currency. Equal to receiptAmount for the same currency. */
    invoiceAmount: settlementAmountSchema,
    exchangeEvidence: settlementEvidenceSchema.optional(),
  }).strict()).min(1).max(100),
  ...settlementEvidenceSchema.shape,
}).strict()
export const receiptActionInputSchema = z.discriminatedUnion("action", [
  z.object({ ...settlementRequest, action: z.literal("refund"), receiptId: z.string().min(1), amount: settlementAmountSchema, ...settlementEvidenceSchema.shape }).strict(),
  z.object({ ...settlementRequest, action: z.literal("customer_credit"), receiptId: z.string().min(1), ...settlementEvidenceSchema.shape }).strict(),
  z.object({ ...settlementRequest, action: z.literal("reverse_allocation"), paymentId: z.string().min(1), ...settlementEvidenceSchema.shape }).strict(),
  z.object({ ...settlementRequest, action: z.literal("reverse_refund"), refundId: z.string().min(1), ...settlementEvidenceSchema.shape }).strict(),
  z.object({ ...settlementRequest, action: z.literal("reverse_receipt"), receiptId: z.string().min(1), ...settlementEvidenceSchema.shape }).strict(),
  z.object({ ...settlementRequest, action: z.enum(["writeoff", "discount"]), invoiceId: z.string().min(1), amount: settlementAmountSchema, ...settlementEvidenceSchema.shape }).strict(),
])
export type ReceiptRecordInput = z.infer<typeof receiptRecordInputSchema>
export type ReceiptAllocateInput = z.infer<typeof receiptAllocateInputSchema>
export type ReceiptActionInput = z.infer<typeof receiptActionInputSchema>
