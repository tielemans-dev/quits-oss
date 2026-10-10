import type { CustomerControl, ImportAllocation, ImportContact, ImportDocument, ImportLedgerItem, SourceBundle } from "./types.ts"

// Checks the extraction matrix against the documentation snapshot, so a matrix row cannot cite an
// endpoint or field the vendor does not document and a new contract field cannot go unmapped.

export const CONTRACT_FIELDS = [
  "contact.sourceId", "contact.name", "contact.email", "contact.country", "contact.taxId", "contact.corporateId",
  "contact.endpointEan", "contact.address", "contact.contactPersons",
  "document.number", "document.kind", "document.issueDate", "document.dueDate", "document.currency",
  "document.exchangeRate", "document.net", "document.tax", "document.gross", "document.baseGross", "document.rounding",
  "document.contactSourceId", "document.lines", "document.vatTreatment", "document.supplyDate",
  "document.correctsInvoice", "document.originalPdf", "document.voucherNumber", "document.accountingYear",
  "document.ledgerEntryNumbers", "document.attachedDocumentNumbers", "document.sourceResidual",
  "document.recomputedResidual",
  "ledgerItem.kind", "ledgerItem.entryNumber", "ledgerItem.contactSourceId", "ledgerItem.date",
  "ledgerItem.currency", "ledgerItem.amount", "ledgerItem.baseAmount", "ledgerItem.sourceResidual",
  "ledgerItem.paymentMethod",
  "allocation.entries", "allocation.amount", "allocation.matchedAt", "allocation.fxDifference",
  "control.customerBalance", "control.unpaidTotals", "extraction.cutover",
] as const

type ContractField = typeof CONTRACT_FIELDS[number]

// Exhaustive key maps bind emitted-field claims to the actual TypeScript draft. Administrative
// identity, exponent and diagnostic fields share the semantic row that explains their value.
const DRAFT_FIELD_ROWS = {
  contact: {
    sourceId: "contact.sourceId", name: "contact.name", email: "contact.email", country: "contact.country",
    taxId: "contact.taxId", corporateId: "contact.corporateId", endpointEan: "contact.endpointEan", address: "contact.address",
  } satisfies Record<keyof ImportContact, ContractField>,
  document: {
    sourceKey: "document.number", kind: "document.kind", number: "document.number", contactSourceId: "document.contactSourceId",
    issueDate: "document.issueDate", dueDate: "document.dueDate", supplyDate: "document.supplyDate",
    currency: "document.currency", exponent: "document.currency", net: "document.net", tax: "document.tax", gross: "document.gross",
    rounding: "document.rounding", baseGross: "document.baseGross", exchangeRate: "document.exchangeRate",
    ledgerEntryNumbers: "document.ledgerEntryNumbers", voucherNumber: "document.voucherNumber", accountingYear: "document.accountingYear",
    originalPdf: "document.originalPdf", attachedDocumentNumbers: "document.attachedDocumentNumbers",
    sourceResidual: "document.sourceResidual", recomputedResidual: "document.recomputedResidual", residualBasis: "document.recomputedResidual",
  } satisfies Record<keyof ImportDocument, ContractField>,
  ledgerItem: {
    sourceKey: "ledgerItem.entryNumber", entryNumber: "ledgerItem.entryNumber", kind: "ledgerItem.kind", contactSourceId: "ledgerItem.contactSourceId",
    date: "ledgerItem.date", currency: "ledgerItem.currency", exponent: "ledgerItem.currency", amount: "ledgerItem.amount",
    baseAmount: "ledgerItem.baseAmount", sourceResidual: "ledgerItem.sourceResidual",
  } satisfies Record<keyof ImportLedgerItem, ContractField>,
  allocation: {
    debitEntry: "allocation.entries", creditEntry: "allocation.entries", amount: "allocation.amount",
    currency: "allocation.amount", exponent: "allocation.amount", clusterId: "allocation.entries",
  } satisfies Record<keyof ImportAllocation, ContractField>,
  control: {
    contactSourceId: "control.customerBalance", baseCurrency: "control.customerBalance", ledgerResidualBase: "control.customerBalance",
    sourceBalanceBase: "control.customerBalance", differenceBase: "control.customerBalance", toleranceBase: "control.customerBalance",
  } satisfies Record<keyof CustomerControl, ContractField>,
  extraction: {
    extractedAt: "extraction.cutover", cutoverDate: "extraction.cutover", baseCurrency: "extraction.cutover", apiVersions: "extraction.cutover",
  } satisfies Record<keyof SourceBundle["extraction"], ContractField>,
}
const DRAFT_ROWS = new Set<string>(Object.values(DRAFT_FIELD_ROWS).flatMap((group) => Object.values(group)))

export const INPUT_FIELDS = [
  "input.debtorDate", "input.accountingYear", "input.accountingYearFromDate", "input.accountingYearToDate",
  "input.debtorBaseAmount", "input.entryCustomer", "input.entryInvoiceNumber", "input.entryType",
  "input.entryAmount", "input.entryRemainder", "input.entryCurrency",
  "input.pairToEntry", "input.pairFromAmount", "input.pairToAmount",
  "input.attachmentVoucher", "input.attachmentYear",
] as const

export type MatrixStatus = "documented" | "executed_demo" | "derived" | "unsupported"

export type MatrixRow = {
  contractField: string
  entity: string
  inDraftContract: boolean
  requirement: "required" | "optional"
  status: MatrixStatus
  source: null | { api: "rest" | "bookedEntries" | "documents"; method: "GET"; endpoint: string; field: string; requiredRoles: string[] }
  notes: string
  unsupportedReason?: string
  derivedFrom?: string[]
  executedProbeIds?: string[]
  exportFallback?: string
}

export type Matrix = { matrixVersion: number; rows: MatrixRow[] }

export type Snapshot = {
  openapi: Record<"BookedEntries" | "Documents", {
    version: string
    requiredRoles: string[]
    endpoints: { method: string; path: string }[]
    schemas: Record<string, string[]>
  }>
  rest: Record<string, { method: string; fields: string[] }>
  rolesByRestPath: Record<string, string[] | string>
  executedProbes: { probes: { id: string }[] }
}

const OPENAPI_SCHEMA_FOR: Record<string, ["BookedEntries" | "Documents", string]> = {
  "/booked-entries": ["BookedEntries", "BookedEntry"],
  "/booked-entries/matched-pairs": ["BookedEntries", "MatchedBookedEntriesPair"],
  "/AttachedDocuments": ["Documents", "AttachedDocument"],
}

const sameRoles = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join()

function restRoleKey(endpoint: string): string | null {
  if (endpoint.startsWith("/customers")) return "/customers"
  if (endpoint.startsWith("/invoices/booked")) return "/invoices/booked"
  if (endpoint === "/accounting-years") return "/accounting-years"
  return null
}

export function validateMatrix(matrix: Matrix, snapshot: Snapshot): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  const probeIds = new Set(snapshot.executedProbes.probes.map((p) => p.id))
  const fields = new Set<string>([...CONTRACT_FIELDS, ...INPUT_FIELDS])

  for (const row of matrix.rows) {
    const at = row.contractField
    if (seen.has(at)) problems.push(`${at}: duplicate row`)
    seen.add(at)
    if (!fields.has(at)) problems.push(`${at}: not a contract field or extraction input`)
    if (row.inDraftContract !== DRAFT_ROWS.has(at)) problems.push(`${at}: inDraftContract differs from the typed emitted draft fields`)
    if (row.status === "unsupported" && !row.unsupportedReason) problems.push(`${at}: unsupported without a reason`)
    if (row.status !== "unsupported" && row.unsupportedReason) problems.push(`${at}: has an unsupported reason but status ${row.status}`)
    if (row.status === "derived") {
      if (!row.derivedFrom?.length) problems.push(`${at}: derived without derivedFrom`)
      if (row.source) problems.push(`${at}: derived rows must not claim a source field`)
    }
    for (const d of row.derivedFrom ?? []) if (!fields.has(d)) problems.push(`${at}: derivedFrom ${d} is not a contract field or extraction input`)
    if (row.status === "executed_demo") {
      if (!row.executedProbeIds?.length) problems.push(`${at}: executed_demo without a probe id`)
      for (const p of row.executedProbeIds ?? []) if (!probeIds.has(p)) problems.push(`${at}: unknown probe ${p}`)
    } else if (row.executedProbeIds?.length) {
      problems.push(`${at}: lists probes but status is ${row.status}`)
    }
    if ((row.status === "documented" || row.status === "executed_demo") && !row.source) problems.push(`${at}: ${row.status} without a source`)

    const src = row.source
    if (!src) continue
    if (src.method !== "GET") problems.push(`${at}: only GET sources are allowed`)
    if (src.api === "rest") {
      const ep = snapshot.rest[src.endpoint]
      if (!ep) problems.push(`${at}: REST endpoint ${src.endpoint} is not in the snapshot`)
      else if (!ep.fields.includes(src.field)) problems.push(`${at}: REST ${src.endpoint} has no documented field ${src.field}`)
      const key = restRoleKey(src.endpoint)
      const documented = key ? snapshot.rolesByRestPath[key] : undefined
      if (Array.isArray(documented) && !sameRoles(documented, src.requiredRoles)) {
        problems.push(`${at}: roles ${src.requiredRoles.join("+")} differ from the permissions page (${documented.join("+")}) for ${key}`)
      }
    } else {
      const spec = src.api === "bookedEntries" ? snapshot.openapi.BookedEntries : snapshot.openapi.Documents
      const [specName, schema] = OPENAPI_SCHEMA_FOR[src.endpoint] ?? []
      const exists = spec.endpoints.some((e) => e.method === "GET" && (e.path === src.endpoint || e.path.replace(/\/\{[^}]+\}/g, "") === src.endpoint))
      if (!exists) problems.push(`${at}: ${src.api} has no GET ${src.endpoint}`)
      if (!specName || !schema) problems.push(`${at}: no schema mapping for ${src.endpoint}`)
      else if (!snapshot.openapi[specName].schemas[schema]?.includes(src.field)) problems.push(`${at}: schema ${schema} has no field ${src.field}`)
      if (!sameRoles(spec.requiredRoles, src.requiredRoles)) problems.push(`${at}: roles ${src.requiredRoles.join("+")} differ from the OpenAPI roles ${spec.requiredRoles.join("+")}`)
    }
  }
  for (const f of CONTRACT_FIELDS) if (!seen.has(f)) problems.push(`${f}: contract field has no matrix row`)
  for (const f of INPUT_FIELDS) if (!seen.has(f)) problems.push(`${f}: extraction input has no matrix row`)
  return problems
}

/** Compare synthetic provider payload field names with the saved documentation inventory. */
export function validateDocumentedPaths(value: unknown, fields: readonly string[]): string[] {
  const allowed = new Set(fields)
  const unknown = new Set<string>()
  const visit = (node: unknown, path: string) => {
    if (path && !allowed.has(path) && !fields.some((field) => field.startsWith(`${path}.`))) {
      unknown.add(path)
      return
    }
    // Arrays repeat a provider shape. Indices are not field names; inspect every element,
    // including nested objects, nulls and empty collections without inventing wildcard paths.
    if (Array.isArray(node)) {
      for (const item of node) visit(item, path)
    } else if (node != null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) visit(child, path ? `${path}.${key}` : key)
    }
  }
  visit(value, "")
  return [...unknown]
}
