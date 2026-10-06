import { z } from "zod"
import { isoDateSchema, nonEmptyStringSchema } from "./baseSchemas"

/** Peppol BIS Billing 3.0 identifiers used by every e-invoice export. */
export const PEPPOL_BIS_CUSTOMIZATION_ID =
  "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0"
export const PEPPOL_BIS_PROFILE_ID = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0"

/**
 * Peppol Electronic Address Scheme (EAS) codes allowed for `cbc:EndpointID/@schemeID`
 * (rule BR-CL-25). Copied from the Peppol BIS Billing 3.0 code list, May 2026 release:
 * https://docs.peppol.eu/poacc/billing/3.0/codelist/eas/ - update it when Peppol publishes a new list.
 */
export const PEPPOL_EAS_CODES = [
  "0002", "0007", "0009", "0060", "0088", "0096", "0097", "0106", "0130", "0135", "0142", "0151",
  "0158", "0183", "0184", "0188", "0190", "0191", "0192", "0195", "0196", "0198", "0199", "0200",
  "0201", "0204", "0208", "0209", "0210", "0211", "0216", "0218", "0221", "0225", "0230", "0235",
  "0240", "0242", "0244", "0245", "0246", "0248", "9910", "9913", "9914", "9915", "9918", "9919",
  "9920", "9922", "9923", "9924", "9925", "9926", "9927", "9928", "9929", "9930", "9931", "9932",
  "9933", "9934", "9935", "9936", "9937", "9938", "9939", "9940", "9941", "9942", "9943", "9944",
  "9945", "9946", "9947", "9948", "9949", "9950", "9951", "9952", "9953", "9957", "9959",
] as const

export type PeppolEasCode = (typeof PEPPOL_EAS_CODES)[number]

const EAS_CODES: ReadonlySet<string> = new Set(PEPPOL_EAS_CODES)

export function isPeppolEasCode(value: string | null | undefined): value is PeppolEasCode {
  return typeof value === "string" && EAS_CODES.has(value.trim())
}

/** GS1 mod-10 check digit, used by GLNs (EAS 0088). */
function hasValidGs1CheckDigit(digits: string) {
  let sum = 0
  for (let index = digits.length - 2, weight = 3; index >= 0; index--, weight = 4 - weight) {
    sum += Number(digits[index]) * weight
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1])
}

/** VAT-number schemes whose identifier is the VAT number with its country prefix. */
const VAT_SCHEME_PREFIX: Record<string, string> = {
  "9910": "HU",
  "9914": "AT",
  "9920": "ES",
  "9925": "BE",
  "9926": "BG",
  "9927": "CHE",
  "9928": "CY",
  "9929": "CZ",
  "9930": "DE",
  "9931": "EE",
  "9932": "GB",
  "9933": "EL",
  "9934": "HR",
  "9935": "IE",
  "9937": "LT",
  "9938": "LU",
  "9939": "LV",
  "9943": "MT",
  "9944": "NL",
  "9945": "PL",
  "9946": "PT",
  "9947": "RO",
  "9949": "SI",
  "9950": "SK",
  "9957": "FR",
}

/** Identifier formats for schemes with a simple, well-defined shape. Other schemes only need a value. */
const SCHEME_ID_FORMAT: Record<string, RegExp> = {
  "0002": /^\d{9}(\d{5})?$/, // FR SIRENE: SIREN or SIRET
  "0007": /^\d{10}$/, // SE organisationsnummer
  "0009": /^\d{14}$/, // FR SIRET
  "0060": /^\d{9}$/, // DUNS
  "0088": /^\d{13}$/, // GS1 GLN
  "0106": /^\d{8}$/, // NL KvK
  "0151": /^\d{11}$/, // AU ABN
  "0184": /^\d{8}$/, // DK CVR
  "0192": /^\d{9}$/, // NO organisasjonsnummer
  "0208": /^[01]\d{9}$/, // BE enterprise number
  "0211": /^IT\d{11}$/, // IT partita IVA
  "9930": /^DE\d{9}$/, // DE USt-IdNr.
}

/**
 * Why a Peppol endpoint is invalid: `scheme` when the scheme is not on the EAS list,
 * `id` when the identifier does not fit the scheme; `null` when it is valid.
 */
export function peppolEndpointIssue(scheme: string, id: string): "scheme" | "id" | null {
  const cleanScheme = scheme.trim()
  if (!isPeppolEasCode(cleanScheme)) return "scheme"
  const cleanId = id.trim().toUpperCase()
  if (!cleanId || cleanId.length > 80 || /\s/.test(cleanId)) return "id"

  const format = SCHEME_ID_FORMAT[cleanScheme]
  if (format && !format.test(cleanId)) return "id"
  if (cleanScheme === "0088" && !hasValidGs1CheckDigit(cleanId)) return "id"

  const prefix = VAT_SCHEME_PREFIX[cleanScheme]
  if (prefix && !new RegExp(`^${prefix}[0-9A-Z]{2,13}$`).test(cleanId)) return "id"
  return null
}

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
  "seller.legalId",
  "seller.electronicAddress",
  "seller.electronicAddressInvalid",
  "buyer.name",
  "buyer.country",
  "buyer.address",
  "buyer.electronicAddress",
  "buyer.electronicAddressInvalid",
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
