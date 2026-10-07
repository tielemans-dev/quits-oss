import { z } from "zod"
import { currencyCodeSchema } from "./baseSchemas"
import {
  currencyExponentSchema, decimalStringSchema, nonnegativeDecimalStringSchema, nonnegativeMoneyStringSchema,
  vatClassificationSchema, draftVatClassificationSchema, vatEvidenceSchema, vatGroupSchema,
} from "./vat"

export const quantityInputSchema = z.string().max(40).regex(/^\d+(?:\.\d{1,6})?$/)
export const unitPriceInputSchema = z.string().max(40).regex(/^\d+(?:\.\d{1,4})?$/)
export const pricingLineInputSchema = z.strictObject({
  quantity: quantityInputSchema,
  unitPrice: unitPriceInputSchema,
  sortOrder: z.number().int().nonnegative(),
  vat: vatClassificationSchema,
  evidence: vatEvidenceSchema.optional(),
})
export const calculateDocumentInputSchema = z.strictObject({
  currency: currencyCodeSchema,
  baseCurrency: currencyCodeSchema.optional(),
  exchangeRate: nonnegativeDecimalStringSchema.default("1").refine((value) => /[1-9]/.test(value), "Exchange rate must be positive"),
  pricesIncludeTax: z.boolean().default(false),
  lines: z.array(pricingLineInputSchema).max(10_000),
  depositApplicationsGross: z.array(nonnegativeDecimalStringSchema).max(10_000).default([]),
}).superRefine((value, ctx) => {
  const orders = value.lines.map((line) => line.sortOrder)
  if (new Set(orders).size !== orders.length)
    ctx.addIssue({ code: "custom", path: ["lines"], message: "sortOrder must be unique" })
  if (value.lines.some((line) => line.vat.treatment === "out_of_scope") &&
      value.lines.some((line) => line.vat.treatment !== "out_of_scope"))
    ctx.addIssue({ code: "custom", path: ["lines"], message: "out_of_scope cannot mix with other treatments" })
})
export const calculateDraftDocumentInputSchema = calculateDocumentInputSchema.safeExtend({
  lines: z.array(pricingLineInputSchema.extend({ vat: draftVatClassificationSchema })).max(10_000),
})
export const pricingLineOutputSchema = pricingLineInputSchema.extend({
  groupKey: z.string(),
  net: decimalStringSchema,
  tax: decimalStringSchema,
  gross: decimalStringSchema,
})
export const calculationMetadataSchema = z.strictObject({
  version: z.literal("v2"),
  roundingMode: z.literal("half_up"),
  pricesIncludeTax: z.boolean(),
  exponent: currencyExponentSchema,
  baseExponent: currencyExponentSchema,
})
export const documentEquationSchema = z.strictObject({
  left: decimalStringSchema,
  right: decimalStringSchema,
  balanced: z.literal(true),
})
export const calculateDocumentOutputSchema = z.strictObject({
  currency: currencyCodeSchema,
  baseCurrency: currencyCodeSchema,
  exchangeRate: nonnegativeDecimalStringSchema,
  calculation: calculationMetadataSchema,
  lines: z.array(pricingLineOutputSchema),
  groups: z.array(vatGroupSchema),
  net: decimalStringSchema,
  tax: decimalStringSchema,
  gross: decimalStringSchema,
  payableRounding: decimalStringSchema,
  depositApplicationsGross: decimalStringSchema,
  payableGross: decimalStringSchema,
  netBase: decimalStringSchema,
  taxBase: decimalStringSchema,
  payableRoundingBase: decimalStringSchema,
  debtorBase: decimalStringSchema,
  equations: z.strictObject({ document: documentEquationSchema, base: documentEquationSchema }),
})
export const creditComponentsInputSchema = z.strictObject({
  group: vatGroupSchema,
  cumulativeBefore: nonnegativeMoneyStringSchema,
  creditedGross: nonnegativeMoneyStringSchema,
})
export const creditComponentsOutputSchema = z.strictObject({
  net: decimalStringSchema,
  tax: decimalStringSchema,
  gross: decimalStringSchema,
  payableRounding: decimalStringSchema,
  netBase: decimalStringSchema,
  taxBase: decimalStringSchema,
  grossBase: decimalStringSchema,
  payableRoundingBase: decimalStringSchema,
  cumulativeGross: nonnegativeMoneyStringSchema,
  equations: z.strictObject({ document: documentEquationSchema, base: documentEquationSchema }),
})
export type CalculateDocumentInput = z.input<typeof calculateDocumentInputSchema>
export type CalculateDocumentOutput = z.infer<typeof calculateDocumentOutputSchema>
export type CreditComponentsInput = z.input<typeof creditComponentsInputSchema>
export type CreditComponentsOutput = z.infer<typeof creditComponentsOutputSchema>
