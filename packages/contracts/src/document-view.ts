import { z } from "zod"
import { currencyCodeSchema } from "./baseSchemas"
import {
  currencyExponentSchema, decimalStringSchema, draftVatEvidenceSchema, nonnegativeDecimalStringSchema,
  vatReasonCodeSchema, vatTreatmentSchema,
} from "./vat"

/**
 * The single description of what a document says. The editor, the read-only page, the PDF and the
 * public page all render from it. Every money value is a decimal string at the currency's exponent;
 * a value that cannot be calculated is `null`, never a guess.
 *
 * Every object is strict and every field is present (nullable rather than optional), so a view has
 * one shape wherever it came from and can be hashed.
 */
export const documentKindSchema = z.enum(["invoice", "quote", "creditNote"])
export const documentStateSchema = z.enum(["draft", "issued"])

/** A real calendar date: "2026-02-30" is refused. */
export const documentViewDateSchema = z.iso.date()
const nullableDate = documentViewDateSchema.nullable()
const moneySchema = decimalStringSchema
const nullableString = z.string().nullable()

export const documentViewTaxIdSchema = z.strictObject({
  scheme: nullableString,
  value: z.string(),
  countryCode: nullableString,
})

export const documentViewBankAccountSchema = z.strictObject({
  accountHolder: nullableString,
  bankName: nullableString,
  regNumber: nullableString,
  accountNumber: nullableString,
  iban: nullableString,
  bic: nullableString,
})

export const documentViewSellerSchema = z.strictObject({
  name: nullableString,
  email: nullableString,
  phone: nullableString,
  address: nullableString,
  logoUrl: nullableString,
  taxIds: z.array(documentViewTaxIdSchema),
})

export const documentViewBuyerSchema = z.strictObject({
  name: nullableString,
  email: nullableString,
  company: nullableString,
  address: nullableString,
  city: nullableString,
  state: nullableString,
  zip: nullableString,
  country: nullableString,
  taxIds: z.array(documentViewTaxIdSchema),
  /** Internal; the public view drops it. */
  contactId: nullableString,
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
  /** Stable per line, and unique within the document. Not an identifier of anything stored. */
  key: z.string().min(1),
  /** Internal; the public view drops it. */
  id: nullableString,
  description: z.string(),
  /** Quantity and price exactly as entered; on an issued line, the frozen inputs. */
  quantity: z.string().max(40),
  unitPrice: z.string().max(40),
  /** The unit price excluding VAT: the price as entered, unrounded, on tax-exclusive documents; derived at two decimals on tax-inclusive ones. Null when the line cannot be calculated. */
  unitPriceNet: moneySchema.nullable(),
  /** Null only when a draft's classification cannot be determined. */
  vat: documentViewLineVatSchema.nullable(),
  net: moneySchema.nullable(),
  tax: moneySchema.nullable(),
  gross: moneySchema.nullable(),
  /** The column printed on the document: `gross` on tax-inclusive documents, otherwise `net`. */
  amount: moneySchema.nullable(),
  /** The line cannot be edited: it is agreement-linked, or the document is issued. */
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

/**
 * `net + tax + payableRounding = gross`. `payable` is the gross less deposit applications, as
 * issued: it is not the balance still outstanding, which payments change.
 */
export const documentViewTotalsSchema = z.strictObject({
  net: moneySchema,
  tax: moneySchema,
  gross: moneySchema,
  payableRounding: moneySchema,
  payable: moneySchema,
})

export const documentViewPaymentDetailsSchema = z.strictObject({
  bankAccount: documentViewBankAccountSchema.nullable(),
  note: nullableString,
  /** The payment reference if set, otherwise the number; null for a draft that has neither. */
  reference: nullableString,
})

/** What a credit note corrects. The original's issue date is null when it was not recorded. */
export const documentViewCorrectionSchema = z.strictObject({
  invoiceNumber: z.string(),
  invoiceIssueDate: nullableDate,
  reason: z.string(),
})

export const documentViewSchema = z.strictObject({
  version: z.literal(1),
  kind: documentKindSchema,
  state: documentStateSchema,
  /** The document's own status value. */
  status: z.string(),
  number: z.strictObject({
    /** The number of an issued document. */
    value: nullableString,
    /** The provisional number a draft would receive next. Never reserved. */
    preview: nullableString,
  }),
  locale: z.string().min(1),
  timezone: z.string().min(1),
  currency: currencyCodeSchema,
  exponent: currencyExponentSchema,
  pricesIncludeTax: z.boolean(),
  seller: documentViewSellerSchema,
  buyer: documentViewBuyerSchema.nullable(),
  dates: z.strictObject({
    issueDate: nullableDate,
    supplyDate: nullableDate,
    dueDate: nullableDate,
    expiryDate: nullableDate,
  }),
  lines: z.array(documentViewLineSchema),
  /** Empty when a draft cannot be calculated. */
  vatGroups: z.array(documentViewVatGroupSchema),
  /** Null when a draft is invalid. */
  totals: documentViewTotalsSchema.nullable(),
  vatEvidence: draftVatEvidenceSchema.nullable(),
  notes: nullableString,
  paymentDetails: documentViewPaymentDetailsSchema.nullable(),
  /** Credit notes only. */
  correction: documentViewCorrectionSchema.nullable(),
  calculation: z.strictObject({
    version: z.enum(["v2", "legacy_per_line"]),
    /** A draft still carrying the legacy calculation's stored amounts; its next edit reprices it. */
    staleLegacy: z.boolean(),
  }),
})

/** What a customer sees: no contact id, no line ids, positional line keys. */
export const publicDocumentViewSchema = z.strictObject({
  ...documentViewSchema.shape,
  buyer: documentViewBuyerSchema.omit({ contactId: true }).nullable(),
  lines: z.array(documentViewLineSchema.omit({ id: true })),
})

export type DocumentKind = z.infer<typeof documentKindSchema>
export type DocumentState = z.infer<typeof documentStateSchema>
export type DocumentViewTaxId = z.infer<typeof documentViewTaxIdSchema>
export type DocumentViewBankAccount = z.infer<typeof documentViewBankAccountSchema>
export type DocumentViewSeller = z.infer<typeof documentViewSellerSchema>
export type DocumentViewBuyer = z.infer<typeof documentViewBuyerSchema>
export type DocumentViewLineVat = z.infer<typeof documentViewLineVatSchema>
export type DocumentViewLine = z.infer<typeof documentViewLineSchema>
export type DocumentViewVatGroup = z.infer<typeof documentViewVatGroupSchema>
export type DocumentViewTotals = z.infer<typeof documentViewTotalsSchema>
export type DocumentViewPaymentDetails = z.infer<typeof documentViewPaymentDetailsSchema>
export type DocumentViewCorrection = z.infer<typeof documentViewCorrectionSchema>
export type DocumentView = z.infer<typeof documentViewSchema>
export type PublicDocumentView = z.infer<typeof publicDocumentViewSchema>
