import { z } from "zod"
import { quantityDecimalSchema, unitPriceDecimalSchema, documentTaxRateSchema, documentTaxRateV2Schema } from "./invoices"
import { decimalStringSchema, vatGroupSchema } from "./vat"
import { quantityInputSchema, unitPriceInputSchema } from "./pricing"
import { documentVatInputSchema } from "./invoices"
import { buyerSnapshotSchema, sellerSnapshotSchema } from "./documents"

export const agreementStatusSchema = z.enum([
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
  "completed",
  "cancelled",
])
export const deliverableStatusSchema = z.enum([
  "planned",
  "in_progress",
  "delivered",
  "accepted",
  "changes_requested",
  "cancelled",
])
export const deliverableBillingStatusSchema = z.enum(["unbilled", "reserved", "invoiced"])
export const agreementBillingTriggerSchema = z.enum(["on_acceptance", "on_delivery"])
export const agreementDateSchema = z.iso.date()
const nullableDate = agreementDateSchema.nullable().optional()
const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/)
export const agreementTermsSchema = z.string().max(50_000)
export const agreementIdInputSchema = z.object({ id: z.string().min(1) }).strict()
export const deliverableInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(500).default(""),
    quantity: z.union([z.number().positive().max(1_000_000), quantityDecimalSchema]),
    unitPrice: z.union([z.number().min(0).max(1_000_000_000), unitPriceDecimalSchema]),
    agreedDate: nullableDate,
    expectedDate: nullableDate,
    isDeposit: z.boolean().default(false),
    vat: documentVatInputSchema.optional(),
  })
  .strict()
export const agreementCreateDraftInputSchema = z
  .object({
    contactId: z.string().trim().min(1),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().max(5000).nullable().optional(),
    termsMarkdown: agreementTermsSchema.default(""),
    templateId: z.string().min(1).nullable().optional(),
    validUntil: agreementDateSchema,
    currency: currencySchema.optional(),
    taxRate: documentTaxRateSchema.default(0),
    dueInDays: z.number().int().min(0).max(3650).default(30),
    billingTrigger: agreementBillingTriggerSchema.default("on_acceptance"),
    notes: z.string().trim().max(5000).nullable().optional(),
    deliverables: z.array(deliverableInputSchema).max(100).default([]),
  })
  .strict()
export const agreementUpdateDraftInputSchema = agreementCreateDraftInputSchema
  .partial()
  .extend({
    id: z.string().min(1),
    termsMarkdown: agreementTermsSchema.optional(),
    taxRate: documentTaxRateSchema.optional(),
    dueInDays: z.number().int().min(0).max(3650).optional(),
    billingTrigger: agreementBillingTriggerSchema.optional(),
    deliverables: z.array(deliverableInputSchema).max(100).optional(),
  })
  .strict()
export const deliverableDecimalInputSchema = deliverableInputSchema.extend({ quantity: quantityDecimalSchema, unitPrice: unitPriceDecimalSchema })
export const agreementCreateDraftDecimalInputSchema = agreementCreateDraftInputSchema.extend({ taxRate: documentTaxRateV2Schema.default("0"), deliverables: z.array(deliverableDecimalInputSchema).max(100).default([]) })
export const agreementUpdateDraftDecimalInputSchema = agreementUpdateDraftInputSchema.extend({ taxRate: documentTaxRateV2Schema.optional(), deliverables: z.array(deliverableDecimalInputSchema).max(100).optional() })
export const deliverableUpdateInputSchema = deliverableInputSchema
  .partial()
  .extend({
    description: z.string().trim().max(500).optional(),
    isDeposit: z.boolean().optional(),
    id: z.string().min(1),
    agreementId: z.string().min(1),
    status: z.literal("in_progress").optional(),
  })
  .strict()
export const deliverableUpdateDecimalInputSchema = deliverableUpdateInputSchema.extend({ quantity: quantityDecimalSchema.optional(), unitPrice: unitPriceDecimalSchema.optional() })

export const agreementTemplateDtoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    termsMarkdown: agreementTermsSchema,
    isDefault: z.boolean(),
  })
  .strict()
export const agreementListInputSchema = z
  .object({
    status: agreementStatusSchema.optional(),
    contactId: z.string().min(1).optional(),
  })
  .strict()

const decimal = z.string().regex(/^-?\d+\.\d{2}$/)
const isoDate = z.iso.datetime()
export const offerDeliverableSnapshotSchema = z
  .object({
    title: z.string(),
    description: z.string(),
    quantity: decimal,
    unitPriceNet: decimal,
    unitPriceGross: decimal,
    lineNet: decimal,
    lineTax: decimal,
    lineGross: decimal,
    taxRate: decimal,
    taxCategory: z.string(),
    taxCode: z.string().nullable(),
    agreedDate: isoDate.nullable(),
    isDeposit: z.boolean(),
    sortOrder: z.number().int(),
  })
  .strict()
export const agreementOfferSnapshotV1Schema = z
  .object({
    sellerSnapshot: sellerSnapshotSchema.nullable(),
    buyerSnapshot: buyerSnapshotSchema.nullable(),
    title: z.string(),
    summary: z.string().nullable(),
    termsHtml: z.string(),
    validUntil: isoDate,
    timezone: z.string(),
    currency: currencySchema,
    countryCode: z.string(),
    locale: z.string(),
    taxRegime: z.string(),
    taxRate: decimal,
    pricesIncludeTax: z.boolean(),
    dueInDays: z.number().int(),
    billingTrigger: agreementBillingTriggerSchema,
    subtotalNet: decimal,
    totalTax: decimal,
    totalGross: decimal,
    deliverables: z.array(offerDeliverableSnapshotSchema),
  })
  .strict()
/** Missing version means the unchanged v1 contract. Never default a version into a hash. */
export const agreementOfferSnapshotV2Schema = agreementOfferSnapshotV1Schema.extend({
  deliverables: z.array(offerDeliverableSnapshotSchema.extend({ quantity: quantityInputSchema })),
  offerFormatVersion: z.literal(2),
  calculationVersion: z.literal("v2"),
  serviceTotal: z.strictObject({ net: decimalStringSchema, tax: decimalStringSchema, gross: decimalStringSchema, payableRounding: decimalStringSchema, vatBasis: z.enum(["net", "gross"]) }),
  paymentSchedule: z.array(z.strictObject({
    title: z.string(), sortOrder: z.number().int(), amount: decimalStringSchema,
    vatBasis: z.enum(["net", "gross"]), trigger: z.literal("on_agreement_acceptance"),
    vatGroupKey: z.string(), net: decimalStringSchema, tax: decimalStringSchema, gross: decimalStringSchema,
  })),
  originalInputs: z.array(z.strictObject({
    sortOrder: z.number().int(), quantity: quantityInputSchema, unitPrice: unitPriceInputSchema,
    inputPrecision: z.enum(["string", "number", "backfilled"]),
    vat: documentVatInputSchema.required(),
  })),
  vatGroups: z.array(vatGroupSchema),
  scheduleVatGroups: z.array(vatGroupSchema),
}).strict()
export const agreementOfferSnapshotSchema = z.union([agreementOfferSnapshotV1Schema, agreementOfferSnapshotV2Schema])
export function readAgreementOfferSnapshot(input: unknown) {
  const version = input && typeof input === "object" && "offerFormatVersion" in input ? input.offerFormatVersion : undefined
  return version === undefined ? agreementOfferSnapshotV1Schema.parse(input) : agreementOfferSnapshotV2Schema.parse(input)
}
export type AgreementCreateDraftInput = z.input<typeof agreementCreateDraftInputSchema>
export type AgreementUpdateDraftInput = z.input<typeof agreementUpdateDraftInputSchema>
export type DeliverableInput = z.input<typeof deliverableInputSchema>
export type AgreementOfferSnapshot = z.infer<typeof agreementOfferSnapshotSchema>

const recipient = z.string().trim().email().max(320)
export const agreementIssueInputSchema = agreementIdInputSchema.extend({ recipient: recipient.optional() }).strict()
export const agreementResendInputSchema = agreementIssueInputSchema
export const agreementRecordAcceptanceInputSchema = agreementIdInputSchema.extend({
  acceptedByName: z.string().trim().min(1).max(200),
  evidenceNote: z.string().trim().min(1).max(5000),
}).strict()
export const agreementCloseInputSchema = agreementIdInputSchema.extend({
  disposition: z.enum(["cancelled", "completed"]),
  cancelRemaining: z.boolean().optional(),
  reason: z.string().trim().min(1).max(5000),
}).strict()
export const deliverablePublicDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("accept"), confirmed: z.literal(true) }).strict(),
  z.object({ decision: z.literal("request_changes"), note: z.string().trim().min(1).max(5000) }).strict(),
])
export const agreementPublicTokenPayloadSchema = z.discriminatedUnion("scope", [
  z.object({ agreementId: z.string().min(1), scope: z.literal("sign_off"), keyVersion: z.number().int().positive(), exp: z.iso.datetime(), deliverableId: z.string().min(1), deliveryRevision: z.number().int().positive() }).strict(),
  z.object({ agreementId: z.string().min(1), scope: z.literal("decide"), keyVersion: z.number().int().positive(), exp: z.iso.datetime(), offerRevision: z.number().int().positive() }).strict(),
  z.object({ agreementId: z.string().min(1), scope: z.literal("read"), keyVersion: z.number().int().positive(), exp: z.iso.datetime() }).strict(),
])
export const agreementPublicDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("accept"), acceptedByName: z.string().trim().min(1).max(200), confirmed: z.literal(true) }).strict(),
  z.object({ decision: z.literal("decline"), reason: z.string().trim().max(5000).optional() }).strict(),
])
export const agreementPublicSubmissionSchema = z.object({
  token: z.string().min(1).max(4096), decision: agreementPublicDecisionSchema,
}).strict()
export type AgreementPublicTokenPayload = z.infer<typeof agreementPublicTokenPayloadSchema>

/** Fulfillment is separate from draft commercial edits. */
export const deliverableIdInputSchema = z
  .object({
    agreementId: z.string().min(1),
    id: z.string().min(1),
  })
  .strict()
export const deliverableAcceptInputSchema = deliverableIdInputSchema
  .extend({
    evidenceNote: z.string().trim().min(1).max(5000),
  })
  .strict()
