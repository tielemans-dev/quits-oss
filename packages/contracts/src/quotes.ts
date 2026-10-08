import { z } from "zod"
import { keyVersionSchema, nonEmptyStringSchema, quoteIdSchema } from "./baseSchemas"
import { calendarDateInputSchema, documentLineInputSchema, documentLineV2InputSchema, refineDocumentLineKeys, documentTaxRateSchema, documentTaxRateV2Schema } from "./invoices"

import { draftVatEvidenceSchema } from "./vat"

const currencySchema = z.string().trim().regex(/^[A-Z]{3}$/)

export const quoteCreateDraftInputSchema = z.object({
  contactId: z.string().trim().min(1),
  expiryDate: calendarDateInputSchema,
  currency: currencySchema.optional(),
  notes: z.string().trim().max(5000).optional(),
  taxRate: documentTaxRateSchema.default(0),
  vatEvidence: draftVatEvidenceSchema.optional(),
  items: z.array(documentLineInputSchema).min(1).max(100).superRefine(refineDocumentLineKeys),
})

export const quoteUpdateDraftInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative().optional(),
  id: z.string().min(1),
  contactId: z.string().trim().min(1).optional(),
  expiryDate: calendarDateInputSchema.optional(),
  currency: currencySchema.optional(),
  notes: z.string().trim().max(5000).optional(),
  taxRate: documentTaxRateSchema.optional(),
  vatEvidence: draftVatEvidenceSchema.optional(),
  items: z.array(documentLineInputSchema).min(1).max(100).superRefine(refineDocumentLineKeys).optional(),
})

export const quoteCreateDraftV2InputSchema = quoteCreateDraftInputSchema.extend({
  taxRate: documentTaxRateV2Schema.default("0"),
  items: z.array(documentLineV2InputSchema).min(1).max(100).superRefine(refineDocumentLineKeys),
})
export const quoteUpdateDraftV2InputSchema = quoteUpdateDraftInputSchema.extend({
  taxRate: documentTaxRateV2Schema.optional(),
  items: z.array(documentLineV2InputSchema).min(1).max(100).superRefine(refineDocumentLineKeys).optional(),
})

export const quoteIdInputSchema = z.object({ id: z.string().min(1) })

export const quoteSendInputSchema = z.object({
  id: z.string().min(1),
  allowSendWithoutEmail: z.boolean().optional(),
})

export const quotePublicDecisionSchema = z.enum(["accepted", "rejected"])
export const quotePublicDecisionStateSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
])
export const quotePublicScopeSchema = z.literal("quote_public")

export const quotePublicTokenPayloadSchema = z
  .object({
    quoteId: quoteIdSchema,
    keyVersion: keyVersionSchema,
    scope: quotePublicScopeSchema,
  })
  .strict()

export const publicQuoteTokenInputSchema = z
  .object({
    token: nonEmptyStringSchema,
  })
  .strict()

export const publicQuoteDecisionInputSchema = publicQuoteTokenInputSchema
  .extend({
    decision: quotePublicDecisionSchema,
    rejectionReason: z.string().trim().max(500).optional(),
  })
  .strict()

export const quotePublicSnapshotSchema = z
  .object({
    status: z.string(),
    publicDecisionAt: z.date().nullable(),
    publicRejectionReason: z.string().nullable().optional(),
  })
  .strict()

export type QuoteCreateDraftInput = z.input<typeof quoteCreateDraftInputSchema>
export type QuoteUpdateDraftInput = z.infer<typeof quoteUpdateDraftInputSchema>
export type QuotePublicDecision = z.infer<typeof quotePublicDecisionSchema>
export type QuotePublicDecisionState = z.infer<
  typeof quotePublicDecisionStateSchema
>
export type QuotePublicScope = z.infer<typeof quotePublicScopeSchema>
export type QuotePublicTokenPayload = z.infer<
  typeof quotePublicTokenPayloadSchema
>
export type QuotePublicSnapshot = z.infer<typeof quotePublicSnapshotSchema>
export type PublicQuoteTokenInput = z.infer<typeof publicQuoteTokenInputSchema>
export type PublicQuoteDecisionInput = z.infer<
  typeof publicQuoteDecisionInputSchema
>
