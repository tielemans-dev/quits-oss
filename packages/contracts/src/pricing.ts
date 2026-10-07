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

/** Frozen document groups before valuation exists. Null never means a 1:1 valuation. */
export const frozenVatGroupSchema = z.strictObject({
  ...vatGroupSchema.shape,
  netBase: decimalStringSchema.nullable(), taxBase: decimalStringSchema.nullable(),
  grossBase: nonnegativeMoneyStringSchema.nullable(), payableRoundingBase: decimalStringSchema.nullable(),
}).superRefine((group, ctx) => {
  const vat = vatClassificationSchema.safeParse({ treatment: group.treatment, reasonCode: group.reasonCode, rate: group.rate, country: group.country })
  if (!vat.success) for (const issue of vat.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message })
  const base = [group.netBase, group.taxBase, group.grossBase, group.payableRoundingBase]
  if (base.some((value) => value === null) && base.some((value) => value !== null))
    ctx.addIssue({ code: "custom", message: "Frozen base components must all be valued or all be null" })
})
export const creditedGroupSchema = z.strictObject({
  original: frozenVatGroupSchema,
  creditedGross: nonnegativeMoneyStringSchema,
  creditedTax: decimalStringSchema,
  creditedNet: decimalStringSchema,
  creditedRounding: decimalStringSchema,
  cumulativeBefore: nonnegativeMoneyStringSchema,
  cumulativeAfter: nonnegativeMoneyStringSchema,
  cumulativeTaxBefore: decimalStringSchema,
  cumulativeTaxAfter: decimalStringSchema,
  cumulativeRoundingBefore: decimalStringSchema,
  cumulativeRoundingAfter: decimalStringSchema,
  remainingGross: nonnegativeMoneyStringSchema,
  remainingTax: decimalStringSchema,
  remainingNet: decimalStringSchema,
  remainingRounding: decimalStringSchema,
  grossBase: decimalStringSchema.nullable(),
  netBase: decimalStringSchema.nullable(),
  taxBase: decimalStringSchema.nullable(),
  payableRoundingBase: decimalStringSchema.nullable(),
})
export const creditedGroupsSchema = z.array(creditedGroupSchema)
export type FrozenVatGroup = z.infer<typeof frozenVatGroupSchema>
export type CreditedGroup = z.infer<typeof creditedGroupSchema>
