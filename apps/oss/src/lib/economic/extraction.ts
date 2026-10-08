import { API_VERSIONS, EconomicClient, EconomicError, safeUrl, sha256, type Surface } from "./client"
import { canonical, currency, integer, normalize, object, text, type Kind, type SourceRecord } from "./shapes"

export const CAPABILITIES = Object.freeze({ direction: "provider_to_read_only_staging", writeback: false, historicalActivation: false, twoGrantConnection: false, readPlans: "Basis, Plus, Smart, Komplet (documented, unverified)", writePlans: "Plus, Smart, Komplet (documented, disabled)", grantWarning: "Quits will only read; e-conomic cannot restrict this connection to reading." })
export function planWriteback(): never { throw new EconomicError("writeback_disabled") }
export type Probe = { area: "sales" | "bookkeeping"; surface: Surface; path: string; state: "readable" | "empty" | "revoked" | "missing_role" | "no_access" | "failed" }
export async function account(client: EconomicClient) {
  const self = object(await client.json("rest", "self"))
  return { accountId: integer(self.agreementNumber), baseCurrency: currency(object(self.settings).baseCurrency) }
}
export async function preflight(client: EconomicClient) {
  const identity = await account(client)
  const probes: Probe[] = []
  for (const [area, surface, path, count] of [
    ["sales", "rest", "customers?pagesize=1", false],
    ["sales", "rest", "invoices/booked?pagesize=1", false],
    ["bookkeeping", "rest", "accounting-years?pagesize=1", false],
    ["bookkeeping", "entries", "booked-entries/count", true],
    ["bookkeeping", "documents", "AttachedDocuments/count", true],
  ] as const) {
    try {
      const response = await client.json(surface, path)
      const empty = count ? integer(response) === "0" : collection(response, "rest").items.length === 0
      probes.push({ area, surface, path, state: empty ? "empty" : "readable" })
    } catch (error) {
      if (!(error instanceof EconomicError)) throw error
      const state = ["revoked", "missing_role", "no_access"].includes(error.code) ? error.code as "revoked" | "missing_role" | "no_access" : "failed"
      probes.push({ area, surface, path, state })
      if (state === "revoked") break
    }
  }
  return { ...identity, probes, readable: probes.length === 5 && probes.every(p => p.state === "readable" || p.state === "empty") }
}
function collection(input: unknown, surface: Surface) {
  const page = object(input)
  const items = surface === "rest" ? page.collection : page.items
  if (!Array.isArray(items) || items.length > 1000) throw new EconomicError("invalid_response", surface)
  const pagination = surface === "rest" ? object(page.pagination) : null
  const total = pagination?.results === undefined ? null : integer(pagination.results)
  const next = surface === "rest" ? pagination!.next : page.cursor
  if (next != null && (typeof next !== "string" || !next || next.length > 4096)) throw new EconomicError("invalid_response", surface)
  return { items, total, next: next == null ? null : text(next) }
}
async function pages(client: EconomicClient, surface: Surface, path: string, kind: Kind, base: string) {
  const rows: SourceRecord[] = []
  const seen = new Set<string>(), links = new Set<string>()
  let link: string | null = surface === "rest" ? `${path}?pagesize=1000&skippages=0` : path
  let pageIndex = 0
  let expectedTotal: string | null | undefined
  while (link !== null) {
    const url = safeUrl(surface, link)
    if (url.pathname !== safeUrl(surface, path).pathname || links.has(url.href) || ++pageIndex > 100) throw new EconomicError("source_drift", surface)
    if (surface === "rest" && (url.searchParams.get("pagesize") !== "1000" || +(url.searchParams.get("skippages") ?? "0") !== pageIndex - 1)) throw new EconomicError("source_drift", surface)
    links.add(url.href)
    const page = collection(await client.json(surface, url.href), surface)
    if (expectedTotal === undefined) expectedTotal = page.total
    else if (expectedTotal !== page.total) throw new EconomicError("source_drift", surface)
    if (page.next && page.items.length === 0) throw new EconomicError("source_drift", surface)
    for (const item of page.items) {
      const row = normalize(kind, item, base)
      if (seen.has(row.sourceId)) throw new EconomicError("duplicate_identity", surface)
      seen.add(row.sourceId); rows.push(row)
    }
    link = page.next === null ? null : surface === "rest" ? page.next : `${path}?cursor=${encodeURIComponent(page.next)}`
  }
  if (expectedTotal != null && BigInt(expectedTotal) !== BigInt(rows.length)) throw new EconomicError("source_drift", surface)
  return rows.sort((a,b) => a.sourceId.localeCompare(b.sourceId))
}
async function scan(client: EconomicClient, base: string) {
  const entriesBefore = integer(await client.json("entries", "booked-entries/count"))
  const docsBefore = integer(await client.json("documents", "AttachedDocuments/count"))
  const result: SourceRecord[] = []
  for (const [surface, path, kind] of [
    ["rest", "customers", "customer"], ["rest", "invoices/booked", "invoice"], ["rest", "accounting-years", "year"],
    ["entries", "booked-entries", "entry"], ["entries", "booked-entries/matched-pairs", "pair"], ["documents", "AttachedDocuments", "attachment"],
  ] as const) result.push(...await pages(client, surface, path, kind, base))
  const entriesAfter = integer(await client.json("entries", "booked-entries/count"))
  const docsAfter = integer(await client.json("documents", "AttachedDocuments/count"))
  if (entriesBefore !== entriesAfter || docsBefore !== docsAfter || entriesAfter !== String(result.filter(r => r.kind === "entry").length) || docsAfter !== String(result.filter(r => r.kind === "attachment").length)) throw new EconomicError("source_drift")
  return result
}
export type Artifact = { kind: "invoice" | "attachment"; sourceId: string; state: "retrieved" | "missing"; sha256: string | null; bytes: number; content: Buffer | null }
export async function extract(client: EconomicClient, expectedAccount: string) {
  const before = await account(client)
  if (before.accountId !== expectedAccount) throw new EconomicError("account_mismatch")
  const records = await scan(client, before.baseCurrency)
  const again = await scan(client, before.baseCurrency)
  if (canonical(records) !== canonical(again)) throw new EconomicError("source_drift")
  const artifacts: Artifact[] = []
  for (const row of records) {
    if (row.kind !== "invoice" && row.kind !== "attachment") continue
    const surface = row.kind === "invoice" ? "rest" : "documents"
    const path = row.kind === "invoice" ? `invoices/booked/${row.sourceId}/pdf` : `AttachedDocuments/${row.sourceId}/pdf`
    const link = row.kind === "invoice" && row.data.pdf ? text(row.data.pdf) : path
    // A safe origin alone is insufficient: bind the document link to this exact record.
    if (safeUrl(surface, link).href !== safeUrl(surface, path).href) throw new EconomicError("unsafe_link", surface)
    try {
      const content = await client.pdf(surface, link)
      artifacts.push({ kind: row.kind, sourceId: row.sourceId, state: "retrieved", sha256: sha256(content), bytes: content.length, content })
    } catch (error) {
      if (!(error instanceof EconomicError)) throw error
      if (error.code !== "not_found") throw new EconomicError(error.code, surface, `${row.kind}:${row.sourceId}`)
      artifacts.push({ kind: row.kind, sourceId: row.sourceId, state: "missing", sha256: null, bytes: 0, content: null })
    }
  }
  const after = await account(client)
  if (canonical(before) !== canonical(after)) throw new EconomicError("source_drift")
  const manifest = { contract: "quits.economic.read-staging/1", provider: "economic", accountId: before.accountId, baseCurrency: before.baseCurrency, apiVersions: API_VERSIONS, origin: "historical_import", intent: "dry_run_only", writeback: false, snapshotGuarantee: "two_equal_reads_not_atomic", unresolvedChecks: ["source_freeze_confirmation", "rest_independent_counts", "unpaid_total_semantics", "ledger_document_reconciliation", "qualified_mapping"], reconciliation: "not_performed", extractedAt: new Date().toISOString(), records, artifacts: artifacts.map(({ content: _content, ...metadata }) => metadata), reads: client.evidence }
  return { manifest, artifacts, hash: sha256(canonical(manifest)) }
}
