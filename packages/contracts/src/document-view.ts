import { z } from "zod"
import { currencyCodeSchema } from "./baseSchemas"
import { buyerSnapshotSchema, documentTaxIdSchema } from "./documents"
import { bankAccountSnapshotSchema } from "./payment-details"
import {
  currencyExponentSchema, decimalStringSchema, draftVatEvidenceSchema, nonnegativeDecimalStringSchema,
  vatReasonCodeSchema, vatTreatmentSchema,
} from "./vat"

/**
 * The single description of what a document says. The editor, the read-only page, the PDF and the
 * public page all render from it. Every money value is a decimal string at the currency's exponent;
 * a value that cannot be calculated is `null`, never a guess.
 */
export const documentKindSchema = z.enum(["invoice", "quote", "creditNote"])
export const documentStateSchema = z.enum(["draft", "issued"])

const calendarDateSchema = z.iso.date().nullable()
const moneySchema = decimalStringSchema

export const documentViewSellerSchema = z.strictObject({
  name: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  logoUrl: z.string().nullable(),
  taxIds: z.array(documentTaxIdSchema),
})

export const documentViewBuyerSchema = z.strictObject({
  ...buyerSnapshotSchema.shape,
  contactId: z.string().nullable(),
})

/**
 * A line's classification as entered. A draft may hold whatever is typed, so this is deliberately
 * looser than `vatClassificationSchema`; issuance validates the classification.
 */
export const documentViewLineVatSchema = z.strictObject({
  treatment: vatTreatmentSchema,
  rate: z.string().max(40),
  reasonCode: vatReasonCodeSchema.nullable(),
  country: z.string().max(10).nullable(),
})

export const documentViewLineSchema = z.strictObject({
  /** Stable per line: its id when it has one, otherwise a key the client chose. */
  key: z.string().min(1),
  id: z.string().nullable(),
  description: z.string(),
  /** Quantity and price exactly as entered; on an issued line, the frozen inputs. */
  quantity: z.string().max(40),
  unitPrice: z.string().max(40),
  /** Null only when a draft's classification cannot be determined. */
  vat: documentViewLineVatSchema.nullable(),
  net: moneySchema.nullable(),
  tax: moneySchema.nullable(),
  gross: moneySchema.nullable(),
  /** The column printed on the document: `gross` on tax-inclusive documents, otherwise `net`. */
  amount: moneySchema.nullable(),
  /** The line keeps its stored amounts and cannot be edited or repriced. */
  locked: z.boolean(),
})

/** Keeps `treatment`, `reasonCode` and `country`: the exemption and reverse-charge text is printed from them. */
export const documentViewVatGroupSchema = z.strictObject({
  ...documentViewLineVatSchema.shape,
  rate: nonnegativeDecimalStringSchema,
  key: z.string(),
  net: moneySchema,
  tax: moneySchema,
  gross: moneySchema,
  /** Stored as is; on tax-inclusive documents it can be a minor unit either way. Never folded into `tax` or `net`. */
  payableRounding: moneySchema,
})

/** `net + tax + payableRounding = gross`, and `payable = gross` less deposit applications. */
export const documentViewTotalsSchema = z.strictObject({
  net: moneySchema,
  tax: moneySchema,
  gross: moneySchema,
  payableRounding: moneySchema,
  payable: moneySchema,
})

export const documentViewPaymentDetailsSchema = z.strictObject({
  bankAccount: bankAccountSnapshotSchema.nullable(),
  note: z.string().nullable(),
  /** The payment reference if set, otherwise the number; null for a draft that has neither. */
  reference: z.string().nullable(),
})

export const documentViewSchema = z.strictObject({
  kind: documentKindSchema,
  state: documentStateSchema,
  /** The document's own status value. */
  status: z.string(),
  number: z.strictObject({
    /** The number of an issued document. */
    value: z.string().nullable(),
    /** The provisional number a draft would receive next. Never reserved. */
    preview: z.string().nullable(),
  }),
  locale: z.string().min(1),
  timezone: z.string().min(1),
  currency: currencyCodeSchema,
  exponent: currencyExponentSchema,
  pricesIncludeTax: z.boolean(),
  seller: documentViewSellerSchema,
  buyer: documentViewBuyerSchema.nullable(),
  dates: z.strictObject({
    issueDate: calendarDateSchema,
    supplyDate: calendarDateSchema,
    dueDate: calendarDateSchema,
    expiryDate: calendarDateSchema,
  }),
  lines: z.array(documentViewLineSchema),
  /** Empty when a draft cannot be calculated. */
  vatGroups: z.array(documentViewVatGroupSchema),
  /** Null when a draft is invalid. */
  totals: documentViewTotalsSchema.nullable(),
  vatEvidence: draftVatEvidenceSchema.nullable(),
  notes: z.string().nullable(),
  paymentDetails: documentViewPaymentDetailsSchema.nullable(),
  calculation: z.strictObject({
    version: z.enum(["v2", "legacy_per_line"]),
    /** A draft priced by the legacy calculation that has not been repriced yet. */
    staleLegacy: z.boolean(),
  }),
})

export type DocumentKind = z.infer<typeof documentKindSchema>
export type DocumentState = z.infer<typeof documentStateSchema>
export type DocumentViewSeller = z.infer<typeof documentViewSellerSchema>
export type DocumentViewBuyer = z.infer<typeof documentViewBuyerSchema>
export type DocumentViewLineVat = z.infer<typeof documentViewLineVatSchema>
export type DocumentViewLine = z.infer<typeof documentViewLineSchema>
export type DocumentViewVatGroup = z.infer<typeof documentViewVatGroupSchema>
export type DocumentViewTotals = z.infer<typeof documentViewTotalsSchema>
export type DocumentViewPaymentDetails = z.infer<typeof documentViewPaymentDetailsSchema>
export type DocumentView = z.infer<typeof documentViewSchema>
