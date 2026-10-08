import { z } from "zod"
import { ARTIFACT_OWNERS, type Manifest } from "../../lib/recovery/format"
import type { ArtifactMeta, DocumentArtifactStore } from "../../lib/runtime/services"
import { hashBytes } from "../../domain/documents/hash"
import { instant, quoteIdent, type QueryFn } from "../../lib/recovery/pgdb"

export type ArtifactGap = Manifest["artifacts"]["missing"][number]
type Row = Record<string, unknown>
type ReadRows = (table: string, columns: readonly string[]) => Promise<Row[]>
export type ArtifactReference = {
  table: string
  id: string
  field: string
  ref: string
  hash: string
  size?: number
  organizationId: string
  documentKind: ArtifactMeta["documentKind"]
  documentId: string
  format: ArtifactMeta["format"]
}
export type ArtifactInventory = { references: ArtifactReference[]; missing: ArtifactGap[] }

const storedArtifact = z.object({ ref: z.string().min(1), hash: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().nonnegative() })
const storedArtifacts = z.object({ pdf: storedArtifact, ubl: storedArtifact.optional() }).strict()
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}
// Same seven-day retired-candidate protection as domain/features/artifact-sweep.ts. Do not
// import that module: importing it registers a scheduler task and loads the application DB.
const RETIRED_RETENTION_MS = 7 * 24 * 3600_000

export const databaseArtifactRows = (query: QueryFn): ReadRows => (table, columns) =>
  query(`SELECT ${columns.map(column => column === "createdAt" ? `${instant(quoteIdent(column))} AS ${quoteIdent(column)}` : quoteIdent(column)).join(", ")} FROM ${quoteIdent(table)} ORDER BY id`)

export function artifactGap(owner: Pick<ArtifactReference, "table" | "id" | "field"> & { ref?: string | null }, problem: string): ArtifactGap {
  return { table: owner.table, id: owner.id, field: owner.field, ref: owner.ref ?? null, problem }
}

/**
 * Reconstruct requirements from durable state, never from the manifest's object list. Staging
 * retains its bytes until abandonment, including an expired preparation not yet swept. Bound
 * candidates can publish after their lease. Published candidates, recent retired candidates,
 * and candidates with unsettled delivery jobs also retain bytes. Old retired history attached
 * only to abandoned staging may legitimately name deleted bytes. Use snapshot time on restore
 * so waiting to restore cannot silently age required objects out of the inventory.
 */
export async function inventoryArtifacts(read: ReadRows, snapshotAt: Date): Promise<ArtifactInventory> {
  const references: ArtifactReference[] = []
  const missing: ArtifactGap[] = []
  for (const owner of ARTIFACT_OWNERS) {
    const columns = ["id", "organizationId", ...(owner.table === "invoice" ? ["status"] : []), ...owner.fields.flatMap(field => [field.ref, field.hash])]
    for (const row of await read(owner.table, columns)) {
      const issued = owner.table === "credit_note" || (owner.table === "invoice" && row.status !== "draft")
      for (const field of owner.fields) {
        const identity = { table: owner.table, id: String(row.id), field: field.ref }
        const ref = row[field.ref]
        if (!ref) {
          if (row[field.hash]) missing.push(artifactGap(identity, "reference_invalid"))
          else if (issued && field.format === "pdf") missing.push(artifactGap(identity, "no_reference"))
          continue
        }
        references.push({ ...identity, ref: String(ref), hash: String(row[field.hash] ?? ""), organizationId: String(row.organizationId),
          documentKind: owner.documentKind, documentId: String(row.id), format: field.format })
      }
    }
  }

  const columns = ["id", "organizationId", "documentKind", "documentId", "status", "artifacts", "renderInputHash"]
  const staging = await read("artifact_staging", columns)
  const candidates = await read("issuance_candidate", [...columns, "stagingId", "createdAt"])
  const unsettled = new Set<string>()
  for (const job of await read("job", ["id", "type", "status", "result", "payload"])) {
    if (job.type !== "email.deliver") continue
    if (!["pending", "queued", "running"].includes(String(job.status)) && job.result != null) continue
    const target = record(record(record(job.payload).completion).target)
    if (typeof target.candidateId === "string") unsettled.add(target.candidateId)
  }
  const stages = new Map(staging.map(row => [String(row.id), row]))
  const retainedStages = new Set(staging.filter(row => row.status !== "abandoned").map(row => String(row.id)))
  const retainedCandidates = candidates.filter(row => {
    // PostgreSQL JSON encodes Prisma's UTC timestamp without an offset. Normalize it so
    // bundle verification and live SQL use the same retention instant in every host timezone.
    const timestamp = String(row.createdAt)
    const createdAt = row.createdAt instanceof Date ? row.createdAt.getTime()
      : new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(timestamp) ? timestamp : `${timestamp}Z`).getTime()
    return row.status !== "retired" || !Number.isFinite(createdAt) || createdAt > snapshotAt.getTime() - RETIRED_RETENTION_MS ||
      unsettled.has(String(row.id)) || retainedStages.has(String(row.stagingId))
  })
  for (const row of retainedCandidates) retainedStages.add(String(row.stagingId))

  const addArtifacts = (table: string, row: Row, required: boolean) => {
    const identity = { table, id: String(row.id), field: "artifacts" }
    if (row.artifacts == null && !required) return
    if (!["invoice", "creditNote", "agreement"].includes(String(row.documentKind))) {
      missing.push(artifactGap(identity, "document_kind_invalid"))
      return
    }
    const parsed = storedArtifacts.safeParse(row.artifacts)
    if (!parsed.success) {
      missing.push(artifactGap(identity, row.artifacts == null ? "required_reference_missing" : "reference_invalid"))
      return
    }
    for (const format of ["pdf", "ubl"] as const) {
      const artifact = parsed.data[format]
      if (artifact) references.push({ ...identity, field: `artifacts.${format}.ref`, ...artifact,
        organizationId: String(row.organizationId), documentKind: row.documentKind as ArtifactMeta["documentKind"], documentId: String(row.documentId), format })
    }
  }
  for (const row of staging) {
    if (!retainedStages.has(String(row.id))) continue
    // A reserved preparation may not have rendered yet; stored/bound work must have a PDF.
    addArtifacts("artifact_staging", row, row.status !== "reserved")
    if (!["reserved", "stored", "missing", "candidate_bound", "published", "abandoned"].includes(String(row.status))) {
      missing.push(artifactGap({ table: "artifact_staging", id: String(row.id), field: "status" }, "lifecycle_invalid"))
    }
  }
  for (const row of retainedCandidates) {
    addArtifacts("issuance_candidate", row, true)
    const identity = { table: "issuance_candidate", id: String(row.id), field: "stagingId" }
    const stage = stages.get(String(row.stagingId))
    if (!stage || ["organizationId", "documentKind", "documentId", "renderInputHash"].some(key => row[key] !== stage[key])) {
      missing.push(artifactGap(identity, "staging_relationship_invalid"))
      continue
    }
    if (!["bound", "published", "retired"].includes(String(row.status)) ||
        (row.status === "bound" && !["candidate_bound", "published"].includes(String(stage.status))) ||
        (row.status === "published" && stage.status !== "published")) {
      missing.push(artifactGap(identity, "lifecycle_invalid"))
    }
    const candidateArtifacts = storedArtifacts.safeParse(row.artifacts)
    const stageArtifacts = storedArtifacts.safeParse(stage.artifacts)
    if (candidateArtifacts.success && stageArtifacts.success && JSON.stringify(candidateArtifacts.data) !== JSON.stringify(stageArtifacts.data)) {
      missing.push(artifactGap({ ...identity, field: "artifacts" }, "staging_candidate_disagreement"))
    }
  }
  for (const id of unsettled) {
    if (!candidates.some(row => row.id === id)) missing.push(artifactGap({ table: "issuance_candidate", id, field: "id" }, "delivery_candidate_missing"))
  }
  return { references, missing }
}

export function groupArtifactReferences(references: ArtifactReference[]) {
  const groups = new Map<string, ArtifactReference[]>()
  for (const reference of references) {
    const group = groups.get(reference.ref)
    if (group) group.push(reference)
    else groups.set(reference.ref, [reference])
  }
  return groups
}

/** Every owner is checked, even when several rows share one content-addressed object. */
export function referenceProblems(reference: ArtifactReference, meta: ArtifactMeta, hash: string, size: number): string[] {
  const problems: string[] = []
  if (!reference.hash) problems.push("hash_not_recorded")
  else if (reference.hash !== hash) problems.push("hash_mismatch")
  if ((reference.size !== undefined && reference.size !== size) || meta.size !== size) problems.push("size_mismatch")
  if (meta.hash !== hash) problems.push("hash_mismatch")
  if (meta.organizationId !== reference.organizationId || meta.documentId !== reference.documentId ||
      meta.documentKind !== reference.documentKind || meta.format !== reference.format) problems.push("metadata_identity_mismatch")
  return problems
}

/** Read and hash bytes, not just metadata. A remote store's head need not read the object. */
export async function inspectArtifact(store: DocumentArtifactStore, ref: string) {
  try {
    const bytes = await store.get(ref)
    const meta = bytes ? await store.head(ref) : null
    if (!bytes || !meta) return { problem: "object_missing" as const }
    return { bytes, meta, hash: hashBytes(bytes) }
  } catch {
    return { problem: "hash_mismatch" as const }
  }
}
