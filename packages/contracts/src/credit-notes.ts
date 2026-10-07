import { z } from "zod"

export const creditDecimalStringSchema = z.string().max(40).regex(/^\d+(?:\.\d{1,2})?$/).refine(value => Number(value) > 0 && Number(value) <= 1_000_000_000)
const creditNumberInput = (schema: z.ZodNumber) => z.union([schema, creditDecimalStringSchema.transform(Number)])

/** Money and quantities are stored with two decimals. */
function hasAtMostTwoDecimals(value: number) {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6
}

export const creditNoteReasonSchema = z.string().trim().min(1).max(500)

export const creditNoteLineSelectionSchema = z.object({
  invoiceItemId: z.string().min(1),
  quantity: creditNumberInput(z.number().positive().max(1_000_000))
    .refine(value => value <= 1_000_000)
    .refine(hasAtMostTwoDecimals, "Quantity can have at most two decimals"),
})

const creditNoteIssueBase = {
  invoiceId: z.string().min(1),
  reason: creditNoteReasonSchema,
}

/**
 * Credits an issued invoice: everything still uncredited (`full`), chosen lines and quantities
 * (`lines`), or a gross amount at the invoice's tax rate (`amount`).
 */
export const creditNoteIssueInputSchema = z.discriminatedUnion("mode", [
  z.object({ ...creditNoteIssueBase, mode: z.literal("full") }),
  z.object({
    ...creditNoteIssueBase,
    mode: z.literal("lines"),
    lines: z.array(creditNoteLineSelectionSchema).min(1).max(100),
  }),
  z.object({
    ...creditNoteIssueBase,
    mode: z.literal("amount"),
    amount: creditNumberInput(z.number().positive().max(1_000_000_000))
      .refine(hasAtMostTwoDecimals, "Amount can have at most two decimals"),
  }),
])

export const creditNoteIdInputSchema = z.object({ id: z.string().min(1) })

export const creditNoteSendInputSchema = creditNoteIdInputSchema

export const creditNoteListInputSchema = z
  .object({ invoiceId: z.string().min(1).optional() })
  .optional()

export const creditNoteStatusSchema = z.enum(["issued"])
export const creditNoteModeSchema = z.enum(["full", "lines", "amount"])

export type CreditNoteLineSelection = z.infer<typeof creditNoteLineSelectionSchema>
export type CreditNoteIssueInput = z.infer<typeof creditNoteIssueInputSchema>
export type CreditNoteSendInput = z.infer<typeof creditNoteSendInputSchema>
export type CreditNoteListInput = z.infer<typeof creditNoteListInputSchema>
export type CreditNoteStatus = z.infer<typeof creditNoteStatusSchema>
export type CreditNoteMode = z.infer<typeof creditNoteModeSchema>
