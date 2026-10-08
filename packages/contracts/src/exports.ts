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

/** GS1 mod-10 check digit, used by GLNs (PEPPOL-COMMON-R040). */
function hasValidGs1CheckDigit(digits: string) {
  let sum = 0
  for (let index = digits.length - 2, weight = 3; index >= 0; index--, weight = 4 - weight) {
    sum += Number(digits[index]) * weight
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1])
}

/** Norwegian organization number mod-11 check digit (PEPPOL-COMMON-R041). */
function hasValidNorwegianCheckDigit(digits: string) {
  const weights = [3, 2, 7, 6, 5, 4, 3, 2]
  const sum = weights.reduce((total, weight, index) => total + Number(digits[index]) * weight, 0)
  return Number(digits) > 0 && (11 - (sum % 11)) % 11 === Number(digits[8])
}

/** Belgian enterprise number mod-97 check (PEPPOL-COMMON-R043). */
function hasValidBelgianCheckDigits(digits: string) {
  return 97 - (Number(digits.slice(0, 8)) % 97) === Number(digits.slice(8))
}

/** Luhn check digit over the first nine digits, used by Swedish organization numbers (PEPPOL-COMMON-R049). */
function hasValidSwedishCheckDigit(digits: string) {
  let sum = 0
  for (let index = 8, double = true; index >= 0; index--, double = !double) {
    const value = Number(digits[index]) * (double ? 2 : 1)
    sum += (value % 10) + Math.floor(value / 10)
  }
  return (10 - (sum % 10)) % 10 === Number(digits[9])
}

/** Australian Business Number mod-89 check (PEPPOL-COMMON-R050). */
function hasValidAbn(digits: string) {
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19]
  const sum = weights.reduce(
    (total, weight, index) => total + (Number(digits[index]) - (index === 0 ? 1 : 0)) * weight,
    0
  )
  return sum % 89 === 0
}

/** Italian partita IVA check digit (PEPPOL-COMMON-R047), on the 11 digits after "IT". */
function hasValidPartitaIva(digits: string) {
  let sum = 0
  for (let index = 0; index < digits.length; index++) {
    const digit = Number(digits[index])
    sum += index % 2 === 1 ? Number("0246813579"[digit]) : digit
  }
  return sum % 10 === 0
}

/** Italian codice fiscale (PEPPOL-COMMON-R045): 11 digits, or the 16-character personal format. */
const CODICE_FISCALE = /^(\d{11}|[A-Za-z]{6}\d{2}[A-Za-z]\d{2}.{3}\d[A-Za-z])$/

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

/** Schemes whose identifiers carry upper-case letters, so a lower-case entry is normalized. */
const UPPER_CASE_SCHEMES: ReadonlySet<string> = new Set([...Object.keys(VAT_SCHEME_PREFIX), "0198", "0211"])

type IdentifierRule = { format: RegExp; check?: (id: string) => boolean }

/**
 * Identifier rules per ISO 6523 ICD / EAS scheme. Checksums and formats follow the PEPPOL-COMMON
 * rules of Peppol BIS Billing 3.0 (https://docs.peppol.eu/poacc/billing/3.0/rules/ubl-peppol/),
 * which apply to endpoint IDs, party identifiers and legal registration numbers alike. Some are
 * stricter than the rule (e.g. 0184 takes only the 8 digits, as Danish endpoints use). Schemes
 * not listed only need a value.
 */
const IDENTIFIER_RULES: Record<string, IdentifierRule> = {
  "0002": { format: /^\d{9}(\d{5})?$/ }, // FR SIRENE: SIREN or SIRET
  "0007": { format: /^\d{10}$/, check: hasValidSwedishCheckDigit }, // SE organisationsnummer, R049
  "0009": { format: /^\d{14}$/ }, // FR SIRET
  "0060": { format: /^\d{9}$/ }, // DUNS
  "0088": { format: /^\d{13}$/, check: hasValidGs1CheckDigit }, // GS1 GLN, R040
  "0096": { format: /^\d{10}$/ }, // DK P-number, R052
  "0106": { format: /^\d{8}$/ }, // NL KvK, R054
  "0151": { format: /^\d{11}$/, check: hasValidAbn }, // AU ABN, R050
  "0184": { format: /^\d{8}$/ }, // DK CVR, R042
  "0190": { format: /^\d{20}$/ }, // NL OIN, R055
  "0192": { format: /^\d{9}$/, check: hasValidNorwegianCheckDigit }, // NO organisasjonsnummer, R041
  "0198": { format: /^DK\d{8}$/ }, // DK SE-number, R053
  "0201": { format: /^[A-Za-z0-9]{6}$/ }, // IT Codice IPA, R044
  "0208": { format: /^\d{10}$/, check: hasValidBelgianCheckDigits }, // BE enterprise number, R043
  "0210": { format: CODICE_FISCALE }, // IT codice fiscale, R045
  "0211": { format: /^IT\d{11}$/, check: (id) => hasValidPartitaIva(id.slice(2)) }, // IT partita IVA, R047
  "9930": { format: /^DE\d{9}$/ }, // DE USt-IdNr.
  "9944": { format: /^NL\d{9}B\d{2}$/ }, // NL btw-nummer, R056-1
}

/**
 * The identifier as an e-invoice must carry it: trimmed, and upper-cased for schemes whose
 * identifiers contain letters (VAT numbers, "DK…", "IT…"). Validate and export this same value.
 */
export function normalizePeppolIdentifier(scheme: string, id: string): string {
  const cleanId = id.trim()
  return UPPER_CASE_SCHEMES.has(scheme.trim()) ? cleanId.toUpperCase() : cleanId
}

/**
 * Whether `id` is a valid identifier for the ISO 6523 ICD / EAS `scheme`, exactly as given (no
 * normalization), so the value checked is the value exported.
 */
export function isValidPeppolIdentifier(scheme: string, id: string): boolean {
  if (!id || id.length > 80 || /\s/.test(id)) return false
  const rule = IDENTIFIER_RULES[scheme]
  if (rule && (!rule.format.test(id) || (rule.check && !rule.check(id)))) return false
  const prefix = VAT_SCHEME_PREFIX[scheme]
  if (prefix && !new RegExp(`^${prefix}[0-9A-Z]{2,13}$`).test(id)) return false
  return true
}

/**
 * Why a Peppol endpoint is invalid: `scheme` when the scheme is not on the EAS list,
 * `id` when the identifier (after {@link normalizePeppolIdentifier}) does not fit the scheme;
 * `null` when it is valid.
 */
export function peppolEndpointIssue(scheme: string, id: string): "scheme" | "id" | null {
  const cleanScheme = scheme.trim()
  if (!isPeppolEasCode(cleanScheme)) return "scheme"
  return isValidPeppolIdentifier(cleanScheme, normalizePeppolIdentifier(cleanScheme, id)) ? null : "id"
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
  "seller.legalIdInvalid",
  "seller.electronicAddress",
  "seller.electronicAddressInvalid",
  "seller.paymentMeansCode",
  "seller.paymentAccountBranch",
  "buyer.name",
  "buyer.country",
  "buyer.address",
  "buyer.legalIdInvalid",
  "buyer.electronicAddress",
  "buyer.electronicAddressInvalid",
  "creditNote.invoiceReference",
])

export const einvoiceExportResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), filename: z.string(), xml: z.string() }),
  z.object({ ok: z.literal(false), missing: z.array(einvoiceMissingFieldSchema).min(1) }),
])

export const accountingDatasetSchema = z.enum(["invoices", "creditNotes", "payments", "settlements"])

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
  settlements: ["event_id", "schema_version", "occurred_at", "event_type", "actor_type", "actor_id", "command_id", "payload_json"],
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
    "payment_id",
    "receipt_id",
    "receipt_amount",
    "receipt_currency",
    "record_kind",
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
