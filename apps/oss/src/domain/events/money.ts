import { z } from "zod"
import { buyerSnapshotSchema, sellerSnapshotSchema } from "@quits/contracts/documents"
import { currencyExponentSchema, decimalStringSchema, vatClassificationSchema } from "@quits/contracts/vat"
import { creditedGroupsSchema, frozenVatGroupSchema } from "@quits/contracts/pricing"

const s = z.string()
const nullableDecimal = decimalStringSchema.nullable()
export const moneySchema = z.strictObject({ minor: s.regex(/^-?\d+$/).nullable(), currency: s.regex(/^[A-Z]{3}$/), exponent: currencyExponentSchema })
export const valuationSchema = z.strictObject({ base: moneySchema, rate: nullableDecimal, rateScale: z.number().int().nonnegative().nullable(), rateDate: z.iso.date().nullable(), rateSource: s.regex(/^(same_currency|user|unknown|provider:.+)$/) })
const artifact = z.strictObject({ ref: s.min(1), hash: s.regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative() })
export const artifactsSchema = z.strictObject({ pdf: artifact, ubl: artifact.optional() })
const dates = { occurredAt: z.iso.datetime(), postingDate: z.iso.date(), issueDate: z.iso.date(), taxPointDate: z.iso.date().nullable(), taxPointReason: z.enum(["invoice_issued", "advance_received", "none", "assessment_required", "tax_point_review"]) }
const line = z.strictObject({ lineId: s, description: s, quantityInput: decimalStringSchema, unitPriceInput: decimalStringSchema, net: decimalStringSchema, tax: decimalStringSchema, gross: decimalStringSchema, vat: vatClassificationSchema, deliverableId: s.nullable().optional() })
export const invoiceIssuedSchema = z.strictObject({
  documentId: s, number: s, purpose: z.enum(["sale", "prepayment"]), ...dates,
  supplyDate: z.iso.date().nullable(), dueDate: z.iso.date(), currency: s, exponent: currencyExponentSchema,
  valuation: valuationSchema,
  vatReporting: z.strictObject({ rate: decimalStringSchema, rateSource: s, taxBaseForReturn: decimalStringSchema, taxForReturn: decimalStringSchema }).optional(),
  lines: z.array(line), vatGroups: z.array(frozenVatGroupSchema),
  totals: z.strictObject({ net: decimalStringSchema, tax: decimalStringSchema, gross: decimalStringSchema, payableRounding: decimalStringSchema, netBase: nullableDecimal, taxBase: nullableDecimal, grossBase: nullableDecimal, payableRoundingBase: nullableDecimal }),
  calculation: z.strictObject({ version: z.enum(["v2", "legacy_per_line"]), roundingMode: z.literal("half_up"), pricesIncludeTax: z.boolean(), exponent: currencyExponentSchema, baseExponent: currencyExponentSchema }),
  seller: sellerSnapshotSchema, buyer: buyerSnapshotSchema,
  coveredByAdvances: z.array(z.never()), depositApplications: z.array(z.never()),
  artifacts: artifactsSchema,
  provenance: z.strictObject({ agreementId: s.nullable(), quoteId: s.nullable(), recurringInvoiceId: s.nullable(), candidateId: s, commandId: s.nullable() }),
})
export type InvoiceIssued = z.infer<typeof invoiceIssuedSchema>
export const creditNoteIssuedSchema = z.union([
  invoiceIssuedSchema.omit({ purpose: true, dueDate: true, coveredByAdvances: true, depositApplications: true }).extend({
    correctsInvoiceId: s, correctsNumber: s, correctsPurpose: z.enum(["sale", "prepayment"]), mode: z.enum(["lines", "amount"]), reason: s,
    creditedGroups: creditedGroupsSchema,
    historicalReversal: z.array(z.strictObject({ key: s, revenueBase: nullableDecimal, taxBase: nullableDecimal, roundingBase: nullableDecimal })),
    debtorDischarge: z.strictObject({ quantity: moneySchema, carryingBase: nullableDecimal, valuationSource: z.enum(["frozen_components", "unknown"]) }),
    customerCreditCreated: z.null(), allocationsReleased: z.array(z.never()).nullable(), fxDifferenceBase: nullableDecimal,
    postable: z.boolean(), incompleteReason: z.enum(["allocations_pending", "purpose_not_supported", "balance_adjustment_unsupported"]).optional(),
  }).strict(),
  // Upcast sparse history without manufacturing missing money, dates or artifacts.
  z.strictObject({ number: s, invoiceId: s, invoiceNumber: s, mode: z.enum(["full", "lines", "amount"]), reason: s, totalGross: z.number(), postable: z.literal(false), incompleteReason: z.literal("historical_payload_incomplete") }),
])
export const baseValuationRecordedSchema = z.strictObject({ documentId: s, number: s, valuation: valuationSchema, vatGroups: z.array(frozenVatGroupSchema), reviewedByUserId: s, evidenceNote: s, occurredAt: z.iso.datetime() })
