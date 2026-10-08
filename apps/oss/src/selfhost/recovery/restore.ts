import { createReadStream } from "node:fs"
import { readFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import type { Client } from "pg"
import type { DocumentArtifactStore } from "../../lib/runtime/services"
import { insideBundle, sha256Bytes, verifyBundle, type BundleCheck, type Finding } from "./bundle"
import { readPendingWork, readTotals } from "./backup"
import { ARTIFACT_OWNERS, ENCRYPTED_COLUMNS, RecoveryError, type CurrencyTotals, type Manifest } from "../../lib/recovery/format"
import { compareKeys, countUndecryptable } from "./keys"
import { orderByDependency, queryFn, quoteIdent, readAppliedMigrations, readTables, utcParam, type QueryFn } from "../../lib/recovery/pgdb"

export type GateName = "integrity" | "artifacts" | "totals" | "rows" | "keys"
export type GateResult = "pass" | "fail" | "skipped"

export type RestoreReport = {
  restoredAt: string
  restoredBy: string
  bundleId: string
  manifestSha256: string
  sourceAppVersion: string
  sourceLastMigration: string
  backupCreatedAt: string
  gates: Record<GateName, GateResult>
  rowCounts: Record<string, number>
  artifactsVerified: number
  warnings: string[]
  pendingWork: Manifest["pendingWork"]
}

/** Raised before anything is written when the bundle cannot be restored safely. */
export class RestoreBlockedError extends RecoveryError {
  constructor(readonly findings: Finding[]) {
    super(
      "restore_blocked",
      `Restore blocked by ${findings.filter((finding) => finding.severity === "error").length} problem(s); nothing was written.`
    )
  }
}

export type RestoreOptions = {
  client: Client
  artifactStore: DocumentArtifactStore
  bundle: string
  env: Record<string, string | undefined>
  /** Rehearse without production secrets: skip the key checks. Enabling then requires an explicit keys exception. */
  skipKeyCheck?: boolean
  /** Restore despite artifacts missing from the bundle; the artifacts gate fails and is recorded. */
  allowIncomplete?: boolean
  appVersion: string
  /** Migrations this release knows, to tell an out-of-date target from a current one. */
  knownMigrations?: readonly string[]
  now?: Date
}

export type Preflight = {
  check: BundleCheck
  findings: Finding[]
  keys: GateResult
  restorable: boolean
}

async function readEncryptedValues(bundle: string, manifest: Manifest) {
  const table = manifest.database.tables.find((candidate) => candidate.name === "org_settings")
  if (!table) return []
  const columns = ENCRYPTED_COLUMNS.filter((entry) => entry.table === "org_settings").map((entry) => entry.column)
  const values: string[] = []
  for (const line of (await readFile(insideBundle(bundle, table.file), "utf8")).split("\n")) {
    if (!line) continue
    const row = JSON.parse(line) as Record<string, unknown>
    for (const column of columns) if (typeof row[column] === "string") values.push(row[column] as string)
  }
  return values
}

/**
 * Everything that can be checked before a single row is written: bundle integrity, the format
 * version, the keys, and whether the target database is migrated, compatible and empty.
 */
export async function preflightRestore(options: RestoreOptions): Promise<Preflight> {
  const check = await verifyBundle(options.bundle)
  const { manifest } = check
  const findings: Finding[] = [...check.findings]
  if (options.allowIncomplete) {
    for (const finding of findings) {
      if (finding.code.startsWith("backup_") && finding.severity === "error") finding.severity = "warning"
    }
  }
  const query = queryFn(options.client)

  // Target schema.
  const target = await readAppliedMigrations(query)
  const sourceLast = manifest.source.migrations.at(-1)!
  if (!target?.length) {
    findings.push({
      severity: "error",
      code: "target_not_migrated",
      message: "The target database has no applied migrations.",
      action: "Run `prisma migrate deploy` (or start the app once) against the empty target database, then restore.",
    })
  } else {
    const absent = manifest.source.migrations.filter((name) => !target.includes(name))
    if (absent.length) {
      findings.push({
        severity: "error",
        code: "target_older_than_backup",
        message: `The backup needs migration ${sourceLast}, which the target database lacks (${absent.length} missing).`,
        action: `Install Quits ${manifest.source.appVersion} or newer and start it against the target to migrate it, then restore.`,
      })
    } else {
      const ahead = target.filter((name) => !manifest.source.migrations.includes(name))
      if (ahead.length) {
        findings.push({
          severity: "warning",
          code: "target_newer_than_backup",
          message: `The target database is ${ahead.length} migration(s) ahead of the backup (backup ${manifest.source.appVersion}, this release ${options.appVersion}). Columns added since take their defaults.`,
        })
      }
    }
    const behind = (options.knownMigrations ?? []).filter((name) => !target.includes(name))
    if (behind.length) {
      findings.push({
        severity: "warning",
        code: "target_behind_release",
        message: `The target database lacks ${behind.length} migration(s) this release expects; the app applies them on its next start.`,
      })
    }

    const tables = new Map((await readTables(query)).map((table) => [table.name, table]))
    for (const source of manifest.database.tables) {
      const table = tables.get(source.name)
      if (!table) {
        findings.push({
          severity: "error",
          code: "schema_table_missing",
          message: `The backup contains table ${source.name}, which the target schema no longer has.`,
          action: `Restore with Quits ${manifest.source.appVersion}, then upgrade.`,
        })
        continue
      }
      const have = new Set(table.columns.map((column) => column.name))
      const dropped = source.columns.filter((column) => !have.has(column))
      if (dropped.length) {
        findings.push({
          severity: "error",
          code: "schema_column_removed",
          message: `The backup holds ${source.name}.${dropped.join(", ")}, which the target schema no longer has.`,
          action: `Restore with Quits ${manifest.source.appVersion}, then upgrade.`,
        })
      }
      const required = table.columns.filter((column) => !source.columns.includes(column.name) && !column.nullable && !column.hasDefault)
      if (required.length) {
        findings.push({
          severity: "error",
          code: "schema_column_required",
          message: `The target requires ${source.name}.${required.map((column) => column.name).join(", ")}, which the backup does not contain.`,
          action: `Restore with Quits ${manifest.source.appVersion}, then upgrade.`,
        })
      }
    }

    // Restoring never overwrites: every table the backup fills must be empty.
    const occupied: string[] = []
    for (const source of manifest.database.tables) {
      if (!tables.has(source.name)) continue
      const rows = await query(`SELECT EXISTS (SELECT 1 FROM ${quoteIdent(source.name)}) AS present`)
      if (rows[0]?.present) occupied.push(source.name)
    }
    if (occupied.length) {
      findings.push({
        severity: "error",
        code: "target_not_empty",
        message: `The target database already holds data (${occupied.slice(0, 5).join(", ")}${occupied.length > 5 ? ", …" : ""}).`,
        action: "Restore into a new, empty database. This tool never overwrites existing data.",
      })
    }
  }

  // Keys.
  let keys: GateResult = "pass"
  if (options.skipKeyCheck) {
    keys = "skipped"
    findings.push({
      severity: "warning",
      code: "keys_not_checked",
      message: "Key checks were skipped. Enabling operations requires an explicit --accept-gate keys exception; this is not a verified cutover.",
      action: "Restore again with the production keys before cutover.",
    })
  } else {
    const keyFindings = compareKeys(manifest.keys.fingerprints, options.env)
    for (const finding of keyFindings) findings.push({ severity: "error", code: finding.code, message: finding.message, action: finding.action })
    if (!keyFindings.length && manifest.keys.encryptedValues) {
      const undecryptable = countUndecryptable(await readEncryptedValues(options.bundle, manifest))
      if (undecryptable) {
        findings.push({
          severity: "error",
          code: "keys_cannot_decrypt",
          message: `${undecryptable} stored provider secret(s) cannot be decrypted with this BETTER_AUTH_SECRET.`,
          action: "Use the BETTER_AUTH_SECRET the source installation ran with.",
        })
      }
    }
    if (findings.some((finding) => finding.severity === "error" && ["missing_key", "wrong_key", "keys_cannot_decrypt"].includes(finding.code))) keys = "fail"
  }

  return { check, findings, keys, restorable: !findings.some((finding) => finding.severity === "error") }
}

async function insertTable(client: Client, bundle: string, table: Manifest["database"]["tables"][number]) {
  if (!table.rows) return
  const columns = table.columns.map(quoteIdent).join(", ")
  const statement = `INSERT INTO ${quoteIdent(table.name)} (${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::${quoteIdent(table.name)}, $1::jsonb)`
  let batch: string[] = []
  let size = 0
  let inserted = 0
  const flush = async () => {
    if (!batch.length) return
    await client.query(statement, [`[${batch.join(",")}]`])
    inserted += batch.length
    batch = []
    size = 0
  }
  const lines = createInterface({ input: createReadStream(insideBundle(bundle, table.file), "utf8"), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line) continue
    batch.push(line)
    size += line.length
    if (batch.length >= 500 || size >= 4_000_000) await flush()
  }
  await flush()
  return inserted
}

/** Differences between two per-currency total sets; empty when they match exactly. */
export function diffTotals(expected: Record<string, CurrencyTotals>, actual: Record<string, CurrencyTotals>) {
  const differences: string[] = []
  const currencies = new Set([...Object.keys(expected), ...Object.keys(actual)])
  for (const currency of [...currencies].sort()) {
    const a = expected[currency]
    const b = actual[currency]
    if (!a || !b) {
      differences.push(`${currency}: ${a ? "missing from the restored database" : "not in the backup manifest"}`)
      continue
    }
    for (const group of ["invoices", "creditNotes", "payments"] as const) {
      for (const field of Object.keys(a[group]) as Array<keyof (typeof a)[typeof group]>) {
        const left = String((a[group] as Record<string, unknown>)[field as string])
        const right = String((b[group] as Record<string, unknown>)[field as string])
        if (left !== right) differences.push(`${currency} ${group}.${String(field)}: backup ${left}, restored ${right}`)
      }
    }
  }
  return differences
}

async function verifyRestoredArtifacts(query: QueryFn, store: DocumentArtifactStore, manifest: Manifest) {
  const known = new Set(manifest.artifacts.missing.map((gap) => `${gap.table}:${gap.id}:${gap.field}`))
  const problems: string[] = []
  let verified = 0
  for (const owner of ARTIFACT_OWNERS) {
    const columns = owner.fields.flatMap((field) => [quoteIdent(field.ref), quoteIdent(field.hash)]).join(", ")
    for (const row of await query(`SELECT id, ${columns} FROM ${quoteIdent(owner.table)} ORDER BY id`)) {
      for (const field of owner.fields) {
        const ref = row[field.ref] == null ? null : String(row[field.ref])
        if (!ref || known.has(`${owner.table}:${row.id}:${field.ref}`)) continue
        const label = `${owner.table} ${row.id} (${field.ref})`
        try {
          const meta = await store.head(ref)
          if (!meta) problems.push(`${label}: object ${ref} is not in the artifact store`)
          else if (row[field.hash] !== meta.hash) problems.push(`${label}: stored hash differs from the recorded hash`)
          else verified += 1
        } catch {
          problems.push(`${label}: object ${ref} does not match its recorded hash`)
        }
      }
    }
  }
  return { verified, problems }
}

/**
 * Restores a bundle into an empty, migrated database and an artifact store, then proves the
 * result before it can be used. The database part is one transaction: any failed check rolls it
 * back and leaves the target empty. The restored installation is left with operations held.
 */
export async function restoreBundle(options: RestoreOptions): Promise<RestoreReport> {
  const preflight = await preflightRestore(options)
  if (!preflight.restorable) throw new RestoreBlockedError(preflight.findings)
  const { manifest } = preflight.check
  const query = queryFn(options.client)
  const warnings = preflight.findings.filter((finding) => finding.severity === "warning").map((finding) => finding.message)
  const incomplete = manifest.artifacts.missing.some((gap) => gap.problem !== "no_reference")

  // Artifacts first: content-addressed and idempotent, so an aborted restore leaves only harmless objects.
  for (const object of manifest.artifacts.objects) {
    const bytes = new Uint8Array(await readFile(insideBundle(options.bundle, object.file)))
    const meta = JSON.parse(await readFile(insideBundle(options.bundle, object.metaFile), "utf8"))
    let ref: string
    try {
      ref = await options.artifactStore.put(bytes, meta)
    } catch (error) {
      throw new RecoveryError("artifact_store_unwritable", `Could not write artifact ${object.ref}: ${(error as Error).message}.`, "Check that QUITS_ARTIFACT_DIR exists, is writable and has space.")
    }
    if (ref !== object.ref) {
      throw new RecoveryError("artifact_ref_changed", `Artifact ${object.ref} was stored as ${ref}.`, "The artifact store naming differs from the source; restore with the Quits release that made the backup.")
    }
  }

  const rowCounts: Record<string, number> = {}
  await options.client.query("BEGIN")
  try {
    const order = await orderByDependency(query, manifest.database.tables.map((table) => table.name))
    for (const name of order) {
      const table = manifest.database.tables.find((candidate) => candidate.name === name)!
      await insertTable(options.client, options.bundle, table)
      const counted = Number((await query(`SELECT count(*)::int AS n FROM ${quoteIdent(name)}`))[0]?.n)
      if (counted !== table.rows) {
        throw new RecoveryError("row_count_mismatch", `${name}: restored ${counted} rows, the backup recorded ${table.rows}.`, "Do not use this bundle; take a new backup.")
      }
      rowCounts[name] = counted
    }

    const differences = diffTotals(manifest.totals, await readTotals(query))
    if (differences.length) {
      throw new RecoveryError("totals_mismatch", `Restored totals differ from the backup manifest: ${differences.join("; ")}.`, "Do not use this bundle; take a new backup.")
    }

    const artifacts = await verifyRestoredArtifacts(query, options.artifactStore, manifest)
    if (artifacts.problems.length && !options.allowIncomplete) {
      throw new RecoveryError("artifacts_unverified", `Restored artifacts do not verify: ${artifacts.problems.slice(0, 3).join("; ")}${artifacts.problems.length > 3 ? `; and ${artifacts.problems.length - 3} more` : ""}.`, "Check the artifact directory, or take a new backup.")
    }
    for (const problem of artifacts.problems) warnings.push(problem)

    const now = options.now ?? new Date()
    const report: RestoreReport = {
      restoredAt: now.toISOString(),
      restoredBy: `quits ${options.appVersion}`,
      bundleId: manifest.bundleId,
      manifestSha256: preflight.check.manifestSha256,
      sourceAppVersion: manifest.source.appVersion,
      sourceLastMigration: manifest.source.migrations.at(-1)!,
      backupCreatedAt: manifest.createdAt,
      gates: {
        integrity: "pass",
        artifacts: incomplete || artifacts.problems.length ? "fail" : "pass",
        totals: "pass",
        rows: "pass",
        keys: preflight.keys,
      },
      rowCounts,
      artifactsVerified: artifacts.verified,
      warnings,
      pendingWork: await readPendingWork(query),
    }
    const reason = `Restored from backup ${manifest.bundleId} taken ${manifest.createdAt}. Nothing has been sent, charged or run since.`
    await query(
      `INSERT INTO recovery_state (id, "operationsMode", "heldReason", "heldAt", "restoredFrom", "restoreReport", "updatedAt")
       VALUES ('default', 'held', $1, ${utcParam(2)}, $3::jsonb, $4::jsonb, ${utcParam(2)})
       ON CONFLICT (id) DO UPDATE SET "operationsMode" = 'held', "heldReason" = $1, "heldAt" = ${utcParam(2)}, "restoredFrom" = $3::jsonb,
         "restoreReport" = $4::jsonb, "enabledAt" = NULL, "updatedAt" = ${utcParam(2)}`,
      [
        reason,
        now,
        JSON.stringify({ bundleId: manifest.bundleId, createdAt: manifest.createdAt, appVersion: manifest.source.appVersion, manifestSha256: preflight.check.manifestSha256 }),
        JSON.stringify(report),
      ]
    )
    await options.client.query("COMMIT")
    return report
  } catch (error) {
    await options.client.query("ROLLBACK").catch(() => undefined)
    throw error
  }
}

export { sha256Bytes }
