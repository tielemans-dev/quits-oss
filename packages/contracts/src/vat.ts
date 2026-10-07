import { z } from "zod"
import { countryCodeSchema } from "./baseSchemas"

/** Plain decimal notation only; money components can be signed. */
export const decimalStringSchema = z.string().max(256).regex(/^-?\d+(?:\.\d+)?$/)
export const nonnegativeDecimalStringSchema = z.string().max(40).regex(/^\d+(?:\.\d+)?$/)
export const nonnegativeMoneyStringSchema = decimalStringSchema.regex(/^\d+(?:\.\d+)?$/)
export const vatTreatmentSchema = z.enum([
  "standard", "intra_community", "export", "exempt", "reverse_charge_domestic",
  "out_of_scope", "zero_rated", "unclassified_zero",
])
export const vatReasonCodes = {
  standard: [],
  intra_community: ["goods", "services_b2b"],
  export: ["goods_outside_eu"],
  exempt: ["financial", "health", "education", "other"],
  reverse_charge_domestic: ["construction", "other"],
  out_of_scope: [],
  zero_rated: [],
  unclassified_zero: [],
} as const
export const vatReasonCodeSchema = z.enum([
  "goods", "services_b2b", "goods_outside_eu", "financial", "health", "education", "other", "construction",
])
export const vatEvidenceSchema = z.strictObject({
  buyerVatId: z.string().min(1).optional(),
  viesCheck: z.strictObject({
    at: z.iso.datetime({ offset: true }),
    result: z.enum(["valid", "invalid", "unavailable"]),
  }).optional(),
  statementText: z.string().min(1).optional(),
  exportEvidence: z.strictObject({
    kind: z.enum(["customs_declaration", "carrier_document", "other"]),
    ref: z.string().min(1),
  }).optional(),
})

export const draftVatEvidenceSchema = vatEvidenceSchema.extend({
  buyerVatId: z.string().max(200).optional(),
  statementText: z.string().max(5000).optional(),
  viesCheck: z.strictObject({ at: z.string().max(100).optional(), result: z.enum(["valid", "invalid", "unavailable"]).optional() }).optional(),
  exportEvidence: z.strictObject({ kind: z.enum(["customs_declaration", "carrier_document", "other"]).optional(), ref: z.string().max(500).optional() }).optional(),
})
export type DraftVatEvidence = z.infer<typeof draftVatEvidenceSchema>

export const vatClassificationSchema = z.strictObject({
  treatment: vatTreatmentSchema,
  reasonCode: vatReasonCodeSchema.nullable().default(null),
  /** Fractional rate: 25% is "0.25". */
  rate: nonnegativeDecimalStringSchema,
  country: countryCodeSchema.nullable().default(null),
}).superRefine((value, ctx) => {
  const positive = /[1-9]/.test(value.rate)
  if ((value.treatment === "standard") !== positive)
    ctx.addIssue({ code: "custom", path: ["rate"], message: "standard requires a positive rate; other treatments require zero" })
  const reasons: readonly string[] = vatReasonCodes[value.treatment]
  if (reasons.length ? !reasons.includes(value.reasonCode ?? "") : value.reasonCode !== null)
    ctx.addIssue({ code: "custom", path: ["reasonCode"], message: "Reason code does not match VAT treatment" })
})

/** A draft can defer its reason code; all supplied classifications and rates remain valid. */
export const draftVatClassificationSchema = z.strictObject(vatClassificationSchema.shape).superRefine((value, ctx) => {
  const parsed = vatClassificationSchema.safeParse(value)
  if (!parsed.success) for (const issue of parsed.error.issues) {
    if (issue.path[0] === "reasonCode" && value.reasonCode === null) continue
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.message })
  }
})

export const currencyExponentSchema = z.union([z.literal(0), z.literal(1), z.literal(2)])
export const vatGroupSchema = vatClassificationSchema.safeExtend({
  key: z.string(),
  exponent: currencyExponentSchema,
  baseExponent: currencyExponentSchema,
  net: decimalStringSchema,
  tax: decimalStringSchema,
  gross: nonnegativeMoneyStringSchema,
  payableRounding: decimalStringSchema,
  netBase: decimalStringSchema,
  taxBase: decimalStringSchema,
  grossBase: nonnegativeMoneyStringSchema,
  payableRoundingBase: decimalStringSchema,
  evidence: vatEvidenceSchema.optional(),
})
export type VatTreatment = z.infer<typeof vatTreatmentSchema>
export type VatReasonCode = z.infer<typeof vatReasonCodeSchema>
export type VatEvidence = z.infer<typeof vatEvidenceSchema>
export type VatGroup = z.infer<typeof vatGroupSchema>
