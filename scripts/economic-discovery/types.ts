// Shapes for the e-conomic import feasibility check.
//
// The Source* types mirror what the vendor documents (REST API for customers, booked invoices and
// accounting years; BookedEntries v6 for ledger entries and matched pairs; Documents v4 for attached
// documents). They carry decimal numbers exactly as the APIs do. The ImportBundle types are the draft
// versioned import contract: integer minor units, explicit provenance, typed exceptions.

export const CONTRACT_VERSION = "quits.import/economic-draft-1" as const

export type SourceCustomer = {
  customerNumber: number
  name: string
  currency?: string
  /** Control total in the agreement's base currency, as the REST API reports it. */
  balance?: number
  country?: string
  vatNumber?: string
  corporateIdentificationNumber?: string
  ean?: string
  email?: string
  address?: string
  zip?: string
  city?: string
}

export type SourceBookedInvoice = {
  bookedInvoiceNumber: number
  date: string
  dueDate?: string
  currency: string
  exchangeRate: number
  customer: { customerNumber: number }
  netAmount: number
  vatAmount: number
  grossAmount: number
  grossAmountInBaseCurrency: number
  roundingAmount?: number
  remainder: number
  remainderInBaseCurrency: number
  pdf?: { download: string }
  delivery?: { deliveryDate?: string }
}

/** BookedEntries v6 item. `type` is the integer code from the OpenAPI enum. */
export type SourceBookedEntry = {
  entryNumber: number
  accountNumber: number
  amount: number
  amountInBaseCurrency: number
  currencyCode?: string | null
  date: string
  dueDate?: string | null
  text?: string | null
  type: number
  voucherNumber?: number | null
  customerNumber?: number | null
  customerInvoiceNumber?: number | null
  remainder?: number | null
}

export type SourceMatchedPair = {
  fromEntry: number
  fromEntryDate: string
  fromEntryAmount: number
  fromEntryAmountDKK: number
  toEntry: number
  toEntryDate: string
  toEntryAmount: number
  toEntryAmountDKK: number
}

export type SourceAttachedDocument = {
  number: number
  pageCount?: number
  voucherNumber: number
  accountingYear: string
}

export type SourceAccountingYear = { year: string; fromDate: string; toDate: string; closed?: boolean }

/** What a fetch of GET /invoices/booked/:n/pdf produced. Recorded by the extractor, never inferred. */
export type PdfFetchEvidence = { status: "ok" | "missing" | "error"; sha256?: string; bytes?: number; httpStatus?: number }

export type SourceBundle = {
  synthetic: true
  extraction: {
    extractedAt: string
    /** Last business date whose documents are imported as history. */
    cutoverDate: string
    baseCurrency: string
    apiVersions: { bookedEntries: string; documents: string; rest: string }
  }
  accountingYears: SourceAccountingYear[]
  customers: SourceCustomer[]
  bookedInvoices: SourceBookedInvoice[]
  entries: SourceBookedEntry[]
  matchedPairs: SourceMatchedPair[]
  attachedDocuments: SourceAttachedDocument[]
  invoicePdfs: Record<string, PdfFetchEvidence>
}

export type Severity = "blocking" | "degraded" | "info"

export type ExceptionCode =
  | "duplicate_source_identity"
  | "sub_minor_precision"
  | "currency_exponent_unknown"
  | "invoice_total_mismatch"
  | "rounding_semantics_unverified"
  | "ledger_entry_without_invoice"
  | "invoice_without_ledger_entry"
  | "multiple_debtor_lines"
  | "debtor_line_amount_mismatch"
  | "debtor_line_currency_mismatch"
  | "debtor_line_base_amount_mismatch"
  | "invoice_ledger_lines_unbalanced"
  | "remainder_disagreement"
  | "remainder_out_of_range"
  | "remainder_missing"
  | "manual_invoice_has_no_document"
  | "entry_type_unsupported"
  | "pair_references_unknown_entry"
  | "cluster_not_conserved"
  | "cluster_currency_mixed"
  | "cluster_customer_mixed"
  | "allocation_ambiguous"
  | "allocation_sign_inconsistent"
  | "applied_without_match_pair"
  | "fx_difference_unattributed"
  | "original_pdf_missing"
  | "original_pdf_fetch_failed"
  | "voucher_year_unresolved"
  | "voucher_number_missing"
  | "document_after_cutover"
  | "snapshot_residual_only"
  | "customer_balance_disagreement"
  | "contact_unknown"

export type ImportException = {
  code: ExceptionCode
  severity: Severity
  /** Stable key of the thing affected, such as `invoice:12` or `entry:44` or `customer:4`. */
  subject: string
  detail: string
}

export type Money = { minor: number; currency: string; exponent: number }

export type ImportContact = {
  sourceId: string
  name: string
  email: string | null
  country: string | null
  taxId: string | null
  corporateId: string | null
  endpointEan: string | null
  address: { line1: string | null; zip: string | null; city: string | null }
}

export type ImportDocument = {
  sourceKey: string
  kind: "invoice" | "credit_note"
  number: string
  contactSourceId: string
  issueDate: string
  dueDate: string | null
  /** Supplied delivery date only; never inferred from issueDate. */
  supplyDate: string | null
  currency: string
  exponent: number
  net: number
  tax: number
  gross: number
  rounding: number
  baseGross: number
  exchangeRate: number
  ledgerEntryNumbers: number[]
  voucherNumber: number | null
  accountingYear: string | null
  originalPdf: { status: PdfFetchEvidence["status"] | "not_fetched"; sha256?: string; bytes?: number; httpStatus?: number }
  attachedDocumentNumbers: number[]
  /** Residual as the source reports it, in minor units of the document currency. */
  sourceResidual: number
  /** Residual recomputed from solved allocations; null when the allocations could not be solved. */
  recomputedResidual: number | null
  residualBasis: "recomputed_from_allocations" | "source_remainder_only"
}

export type ImportLedgerItem = {
  sourceKey: string
  entryNumber: number
  kind: "payment" | "payment_reversal" | "opening_balance" | "manual_invoice"
  contactSourceId: string
  date: string
  currency: string
  exponent: number
  amount: number
  baseAmount: number
  sourceResidual: number
}

export type ImportAllocation = {
  /** Both endpoints must appear in documents.ledgerEntryNumbers or ledgerItems.entryNumber. */
  debitEntry: number
  creditEntry: number
  amount: number
  currency: string
  exponent: number
  clusterId: string
}

export type ClusterStatus = "resolved" | "ambiguous" | "inconsistent"

export type ImportCluster = {
  id: string
  /** Full-extraction diagnostics; may include entries excluded from import at cutover. */
  entries: number[]
  status: ClusterStatus
  /** Per entry: how much of the entry was applied (amount minus remainder), signed, minor units. */
  applied: Record<string, number>
}

export type ReconciliationRow = {
  contactSourceId: string
  currency: string
  documentKey: string | null
  kind: "document" | "unapplied_cash" | "open_credit" | "ledger_item"
  sourceResidual: number
  recomputedResidual: number | null
  /** null when the allocations could not be solved, so the source remainder is unproven. */
  match: boolean | null
}

export type CustomerControl = {
  contactSourceId: string
  baseCurrency: string
  /** Sum of source residuals converted to base minor units. */
  ledgerResidualBase: number
  sourceBalanceBase: number | null
  differenceBase: number | null
  /** Largest rounding error to expect from converting partial residuals to base. */
  toleranceBase: number
}

export type ImportBundle = {
  contractVersion: typeof CONTRACT_VERSION
  synthetic: true
  provenance: SourceBundle["extraction"]
  contacts: ImportContact[]
  documents: ImportDocument[]
  ledgerItems: ImportLedgerItem[]
  allocations: ImportAllocation[]
  clusters: ImportCluster[]
  excludedAfterCutover: string[]
  exceptions: ImportException[]
  reconciliation: { rows: ReconciliationRow[]; customerControls: CustomerControl[]; allRowsMatch: boolean }
}
