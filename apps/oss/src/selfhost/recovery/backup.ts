import { randomUUID } from "node:crypto"
import { createHash } from "node:crypto"
import { mkdir, open, readdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Client } from "pg"
import { readProductEnv } from "@quits/shared/runtimeEnv"
import type { DocumentArtifactStore } from "../../lib/runtime/services"
import { insideBundle, sha256Bytes } from "./bundle"
import {
  ARTIFACT_DIRECTORY,
  ARTIFACT_OWNERS,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  DATABASE_DIRECTORY,
  EXCLUDED_TABLES,
  MANIFEST_FILE,
  RecoveryError,
  REDACTED_COLUMNS,
  type CurrencyTotals,
  type Manifest,
} from "./format"
import { configurationInventory, keyFingerprints } from "./keys"
import { quoteIdent, queryFn, readAppliedMigrations, readPostgresVersion, readTables, type QueryFn } from "./pgdb"

const FETCH_ROWS = 500

export type CreateBackupOptions = {
  client: Client
  artifactStore: DocumentArtifactStore
  directory: string
  env: Record<string, string | undefined>
  appVersion: string
  /** Proceed even when issued documents lack their stored artifacts; the gaps are recorded. */
  allowIncomplete?: boolean
  /** Record the backup in the database so the app can report its age. Default true. */
  record?: boolean
  now?: Date
}

/** Per-currency money totals as exact decimal strings, computed by PostgreSQL. */
export async function readTotals(query: QueryFn): Promise<Record<string, CurrencyTotals>> {
  const totals: Record<string, CurrencyTotals> = {}
  const entry = (currency: string) =>
    (totals[currency] ??= {
      invoices: { count: 0, gross: "0", paid: "0", credited: "0" },
      creditNotes: { count: 0, gross: "0" },
      payments: { count: 0, amount: "0", voidedCount: 0, voidedAmount: "0" },
    })
  for (const row of await query(`
    SELECT currency, count(*)::int AS n, sum("totalGross")::text AS gross, sum("amountPaid")::text AS paid, sum("amountCredited")::text AS credited
    FROM invoice WHERE status <> 'draft' GROUP BY currency`)) {
    entry(String(row.currency)).invoices = { count: Number(row.n), gross: String(row.gross), paid: String(row.paid), credited: String(row.credited) }
  }
  for (const row of await query(`
    SELECT currency, count(*)::int AS n, sum("totalGross")::text AS gross FROM credit_note GROUP BY currency`)) {
    entry(String(row.currency)).creditNotes = { count: Number(row.n), gross: String(row.gross) }
  }
  for (const row of await query(`
    SELECT currency,
      count(*) FILTER (WHERE "voidedAt" IS NULL)::int AS n,
      coalesce(sum(amount) FILTER (WHERE "voidedAt" IS NULL), 0)::text AS amount,
      count(*) FILTER (WHERE "voidedAt" IS NOT NULL)::int AS voided_n,
      coalesce(sum(amount) FILTER (WHERE "voidedAt" IS NOT NULL), 0)::text AS voided_amount
    FROM payment GROUP BY currency`)) {
    entry(String(row.currency)).payments = {
      count: Number(row.n),
      amount: String(row.amount),
      voidedCount: Number(row.voided_n),
      voidedAmount: String(row.voided_amount),
    }
  }
  return totals
}

/** Work that was queued or due when the snapshot was taken. */
export async function readPendingWork(query: QueryFn): Promise<Manifest["pendingWork"]> {
  const jobs = await query(`SELECT status, type, count(*)::int AS n FROM job GROUP BY status, type`)
  const byStatus = (status: string) => jobs.filter((row) => row.status === status).reduce((sum, row) => sum + Number(row.n), 0)
  const jobsByType: Record<string, number> = {}
  for (const row of jobs.filter((row) => row.status === "pending" || row.status === "running")) {
    jobsByType[String(row.type)] = (jobsByType[String(row.type)] ?? 0) + Number(row.n)
  }
  const scalar = async (sql: string) => Number((await query(sql))[0]?.n ?? 0)
  return {
    jobsPending: byStatus("pending"),
    jobsRunning: byStatus("running"),
    jobsFailed: byStatus("failed"),
    jobsByType,
    remindersDue: await scalar(`SELECT count(*)::int AS n FROM invoice_reminder WHERE "sentAt" IS NULL AND "scheduledFor" <= now()`),
    recurringDue: await scalar(`SELECT count(*)::int AS n FROM recurring_invoice WHERE status = 'active' AND "nextRunAt" <= now()`),
    eventDeliveriesPending: await scalar(`SELECT count(*)::int AS n FROM event_consumer_delivery WHERE status IN ('pending','claimed')`),
  }
}

async function writeTable(client: Client, directory: string, table: { name: string; columns: string[]; primaryKey: string[] }) {
  const redacted = new Set(REDACTED_COLUMNS[table.name] ?? [])
  const select = table.columns.map((column) => (redacted.has(column) ? `NULL::text AS ${quoteIdent(column)}` : `t.${quoteIdent(column)}`)).join(", ")
  const order = (table.primaryKey.length ? table.primaryKey : table.columns).map((column) => `x.${quoteIdent(column)}`).join(", ")
  const file = `${DATABASE_DIRECTORY}/${table.name}.jsonl`
  const path = insideBundle(directory, file)
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, "w", 0o600)
  const hash = createHash("sha256")
  let rows = 0
  let bytes = 0
  try {
    // row_to_json writes numbers exactly as PostgreSQL holds them; the line is never parsed here.
    await client.query(`DECLARE backup_cursor NO SCROLL CURSOR FOR SELECT row_to_json(x)::text AS line FROM (SELECT ${select} FROM ${quoteIdent(table.name)} t) x ORDER BY ${order}`)
    for (;;) {
      const { rows: lines } = await client.query(`FETCH ${FETCH_ROWS} FROM backup_cursor`)
      if (!lines.length) break
      const chunk = Buffer.from(lines.map((row) => `${row.line}\n`).join(""))
      hash.update(chunk)
      await handle.write(chunk)
      rows += lines.length
      bytes += chunk.byteLength
    }
    await client.query(`CLOSE backup_cursor`)
  } finally {
    await handle.close()
  }
  return { file, rows, bytes, sha256: hash.digest("hex") }
}

type ArtifactGap = Manifest["artifacts"]["missing"][number]

async function collectArtifacts(input: {
  query: QueryFn
  store: DocumentArtifactStore
  directory: string
}) {
  const objects = new Map<string, Manifest["artifacts"]["objects"][number]>()
  const missing: ArtifactGap[] = []
  for (const owner of ARTIFACT_OWNERS) {
    const refColumns = owner.fields.flatMap((field) => [quoteIdent(field.ref), quoteIdent(field.hash)]).join(", ")
    const rows = await input.query(
      `SELECT id, "organizationId", ${refColumns}${owner.table === "invoice" ? ", status" : ""} FROM ${quoteIdent(owner.table)} ORDER BY id`
    )
    for (const row of rows) {
      const issued = owner.table === "credit_note" || (owner.table === "invoice" && row.status !== "draft")
      for (const field of owner.fields) {
        const ref = row[field.ref] == null ? null : String(row[field.ref])
        const recorded = row[field.hash] == null ? null : String(row[field.hash])
        const gap = (problem: string): ArtifactGap => ({ table: owner.table, id: String(row.id), field: field.ref, ref, problem })
        if (!ref) {
          if (issued && field.format === "pdf") missing.push(gap("no_reference"))
          continue
        }
        if (objects.has(ref)) continue
        let bytes: Uint8Array | null
        let metaText: string | null = null
        try {
          bytes = await input.store.get(ref)
          const meta = bytes ? await input.store.head(ref) : null
          metaText = meta ? JSON.stringify(meta) : null
        } catch {
          missing.push(gap("hash_mismatch"))
          continue
        }
        if (!bytes || !metaText) {
          missing.push(gap("object_missing"))
          continue
        }
        const actual = sha256Bytes(bytes)
        if (recorded === null) missing.push(gap("hash_not_recorded"))
        else if (recorded !== actual) {
          missing.push(gap("hash_mismatch"))
          continue
        }
        const file = `${ARTIFACT_DIRECTORY}/${ref}`
        const metaFile = `${file}.meta.json`
        for (const [name, content] of [[file, bytes], [metaFile, metaText]] as const) {
          const path = insideBundle(input.directory, name)
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, content, { mode: 0o600 })
        }
        objects.set(ref, {
          ref,
          file,
          metaFile,
          sha256: actual,
          bytes: bytes.byteLength,
          owner: { table: owner.table, id: String(row.id), organizationId: String(row.organizationId), field: field.ref },
        })
      }
    }
  }
  return { objects: [...objects.values()], missing }
}

/**
 * Writes a verified backup bundle from a consistent snapshot. The database is read in one
 * read-only REPEATABLE READ transaction, so tables, totals and pending work describe the same
 * instant. Nothing in the source is changed except a `backup_record` row (unless `record` is false).
 */
export async function createBackup(options: CreateBackupOptions) {
  const { client, directory } = options
  const now = options.now ?? new Date()
  try {
    const existing = await readdir(directory)
    if (existing.length) {
      throw new RecoveryError("output_not_empty", `${directory} already contains files.`, "Choose a new, empty directory; backups are never overwritten.")
    }
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })

  const query = queryFn(client)
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
  let manifest: Manifest
  try {
    const migrations = await readAppliedMigrations(query)
    if (!migrations?.length) {
      throw new RecoveryError("database_not_migrated", "The database has no applied migrations.", "Point DATABASE_URL at the installation to back up.")
    }
    const allTables = await readTables(query)
    const excluded = allTables.filter((table) => table.name in EXCLUDED_TABLES)
    const included = allTables.filter((table) => !(table.name in EXCLUDED_TABLES))
    const tables = []
    for (const table of included) {
      const written = await writeTable(client, directory, {
        name: table.name,
        columns: table.columns.map((column) => column.name),
        primaryKey: table.primaryKey,
      })
      tables.push({ name: table.name, columns: table.columns.map((column) => column.name), ...written })
    }
    const artifacts = await collectArtifacts({ query, store: options.artifactStore, directory })
    const hard = artifacts.missing.filter((gap) => gap.problem !== "no_reference")
    if (hard.length && !options.allowIncomplete) {
      const first = hard[0]!
      throw new RecoveryError(
        "artifacts_incomplete",
        `${hard.length} issued document artifact(s) are missing or do not match their recorded hash (first: ${first.table} ${first.id}, ${first.field}, ${first.problem}).`,
        "Restore the artifact directory from its own backup first, or pass --allow-incomplete to record the gaps and continue."
      )
    }
    manifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      bundleId: randomUUID(),
      createdAt: now.toISOString(),
      source: {
        appVersion: options.appVersion,
        distribution: readProductEnv(options.env, "DISTRIBUTION")?.trim() || "selfhost",
        postgresVersion: await readPostgresVersion(query),
        migrations,
      },
      database: {
        tables: tables.map((table) => ({ name: table.name, file: table.file, rows: table.rows, bytes: table.bytes, sha256: table.sha256, columns: table.columns })),
        excluded: excluded.map((table) => ({ table: table.name, reason: EXCLUDED_TABLES[table.name]! })),
        redacted: Object.entries(REDACTED_COLUMNS)
          .filter(([name]) => included.some((table) => table.name === name))
          .map(([table, columns]) => ({ table, columns: [...columns] })),
      },
      artifacts,
      totals: await readTotals(query),
      keys: {
        fingerprints: keyFingerprints(options.env),
        encryptedValues: Number(
          (await query(`SELECT count(*)::int AS n FROM org_settings, LATERAL (VALUES ("aiApiKeyEnc"), ("stripeSecretKeyEnc"), ("stripeWebhookSecretEnc")) v(value) WHERE v.value IS NOT NULL`))[0]?.n ?? 0
        ),
      },
      configuration: configurationInventory(options.env),
      pendingWork: await readPendingWork(query),
    }
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  }

  const text = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(join(directory, MANIFEST_FILE), text, { mode: 0o600 })
  const manifestSha256 = sha256Bytes(text)
  await writeFile(join(directory, `${MANIFEST_FILE}.sha256`), `${manifestSha256}  ${MANIFEST_FILE}\n`, { mode: 0o600 })

  if (options.record !== false) {
    await recordBackup(query, "created", manifest, manifestSha256)
  }
  return { manifest, manifestSha256, directory }
}

/** Remembers that a bundle was created or verified, so the app can report backup age. */
export async function recordBackup(query: QueryFn, kind: "created" | "verified", manifest: Manifest, manifestSha256: string) {
  await query(
    `INSERT INTO backup_record (id, kind, "bundleId", "manifestSha256", "formatVersion", summary) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      randomUUID(),
      kind,
      manifest.bundleId,
      manifestSha256,
      manifest.formatVersion,
      JSON.stringify({
        createdAt: manifest.createdAt,
        tables: manifest.database.tables.length,
        rows: manifest.database.tables.reduce((sum, table) => sum + table.rows, 0),
        artifacts: manifest.artifacts.objects.length,
        artifactGaps: manifest.artifacts.missing.length,
        currencies: Object.keys(manifest.totals),
      }),
    ]
  )
}
