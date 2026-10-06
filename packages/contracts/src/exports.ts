import { z } from "zod"
import { isoDateSchema, nonEmptyStringSchema } from "./baseSchemas"

/** Peppol BIS Billing 3.0 identifiers used by every e-invoice export. */
export const PEPPOL_BIS_CUSTOMIZATION_ID =
  "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0"
export const PEPPOL_BIS_PROFILE_ID = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0"

export const einvoiceDocumentKindSchema = z.enum(["invoice", "creditNote"])

export const einvoiceExportInputSchema = z.object({
  kind: einvoiceDocumentKindSchema,
  id: nonEmptyStringSchema.max(100),
})

/**
 * Data a Peppol BIS Billing 3.0 document needs that the source document does not have.
 * Codes are stable so the UI and agents can explain each one.
 */
export const einvoiceMissingFieldSchema = z.enum([
  "document.notIssued",
  "document.lines",
  "seller.name",
  "seller.country",
  "seller.address",
  "seller.taxId",
  "seller.electronicAddress",
  "buyer.name",
  "buyer.country",
  "buyer.address",
  "buyer.electronicAddress",
  "creditNote.invoiceReference",
])

export const einvoiceExportResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), filename: z.string(), xml: z.string() }),
  z.object({ ok: z.literal(false), missing: z.array(einvoiceMissingFieldSchema).min(1) }),
])

export const accountingDatasetSchema = z.enum(["invoices", "creditNotes", "payments"])

/** Inclusive calendar-date range, interpreted in the organization's time zone. */
export const accountingExportInputSchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    dataset: accountingDatasetSchema,
  })
  .refine((value) => value.from <= value.to, {
    message: "The start date must be on or before the end date",
    path: ["to"],
  })

export const accountingExportResultSchema = z.object({
  filename: z.string(),
  csv: z.string(),
})

/**
 * Stable CSV column contracts. Columns are only ever appended, never renamed or reordered,
 * so spreadsheets and accounting imports built on an export keep working.
 */
export const ACCOUNTING_EXPORT_COLUMNS = {
  invoices: [
    "number",
    "issue_date",
    "due_date",
    "customer",
    "currency",
    "net",
    "tax",
    "gross",
    "paid",
    "credited",
    "balance",
    "status",
  ],
  creditNotes: [
    "number",
    "invoice_number",
    "issue_date",
    "customer",
    "currency",
    "net",
    "tax",
    "gross",
    "reason",
  ],
  payments: [
    "paid_date",
    "invoice_number",
    "customer",
    "currency",
    "amount",
    "method",
    "reference",
    "voided",
    "void_reason",
  ],
} as const satisfies Record<AccountingDataset, readonly string[]>

export type EinvoiceDocumentKind = z.infer<typeof einvoiceDocumentKindSchema>
export type EinvoiceExportInput = z.infer<typeof einvoiceExportInputSchema>
export type EinvoiceMissingField = z.infer<typeof einvoiceMissingFieldSchema>
export type EinvoiceExportResult = z.infer<typeof einvoiceExportResultSchema>
export type AccountingDataset = z.infer<typeof accountingDatasetSchema>
export type AccountingExportInput = z.infer<typeof accountingExportInputSchema>
export type AccountingExportResult = z.infer<typeof accountingExportResultSchema>
export type AccountingColumn<Dataset extends AccountingDataset> =
  (typeof ACCOUNTING_EXPORT_COLUMNS)[Dataset][number]
