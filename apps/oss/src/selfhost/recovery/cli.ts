import { readFileSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "pg"
import { readProductEnv } from "@quits/shared/runtimeEnv"
import { localDiskArtifactStore } from "../artifact-store"
import { createBackup, recordBackup } from "./backup"
import { verifyBundle, type Finding } from "./bundle"
import { RecoveryError } from "./format"
import { configurationInventory } from "./keys"
import { enableOperations, reviewPendingWork, reviewToken } from "./operations"
import { queryFn, readAppliedMigrations, readPostgresVersion } from "./pgdb"
import { preflightRestore, restoreBundle, RestoreBlockedError, type GateName } from "./restore"
import { collectOperationalStatus, environmentHold } from "./status"

type Env = Record<string, string | undefined>
export type Io = { out: (text: string) => void; err: (text: string) => void }

const USAGE = `Usage: recovery <command> [options]

  prerequisites                      Check what a restore needs on this machine
  backup create --out DIR            Write a verified backup bundle
  backup verify DIR [--record]       Check a bundle against its manifest (no database needed)
  restore DIR                        Restore into an empty, migrated database; operations stay held
  status                             Backup age, artifacts, scheduler and mail health
  review                             Show pending work and the token needed to enable operations
  enable-operations                  End the hold after review

Common options:
  --database-url URL   Database to use (default: DATABASE_URL)
  --artifact-dir DIR   Issued-document directory (default: QUITS_ARTIFACT_DIR or ./data/artifacts)
  --json               Machine-readable output

backup create:  --out DIR  [--allow-incomplete]  [--no-record]
restore:        [--dry-run]  [--skip-key-check]  [--allow-incomplete]
enable-operations:  --review-token T  --jobs keep|cancel  --source-stopped  [--accept-gate NAME]...
status:         [--full]   (check every issued artifact object, not just the newest 2000)
`

type Parsed = { positional: string[]; flags: Map<string, string[]> }

const BOOLEAN_FLAGS = new Set(["json", "dry-run", "skip-key-check", "allow-incomplete", "no-record", "record", "source-stopped", "full", "help"])

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = []
  const flags = new Map<string, string[]>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
    let value = inline
    if (value === undefined && !BOOLEAN_FLAGS.has(name)) {
      value = argv[index + 1]
      index += 1
      if (value === undefined) throw new RecoveryError("usage", `--${name} needs a value.`)
    }
    flags.set(name, [...(flags.get(name) ?? []), value ?? "true"])
  }
  return { positional, flags }
}

const flag = (parsed: Parsed, name: string) => parsed.flags.get(name)?.at(-1)
const has = (parsed: Parsed, name: string) => parsed.flags.has(name)

function appVersion() {
  return (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version
}

async function knownMigrations() {
  const entries = await readdir(fileURLToPath(new URL("../../../prisma/migrations/", import.meta.url)))
  return entries.filter((name) => /^\d/.test(name)).sort()
}

function describeDatabase(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`
  } catch {
    return "(unparseable database url)"
  }
}

async function connect(parsed: Parsed, env: Env) {
  const url = flag(parsed, "database-url") ?? env.DATABASE_URL
  if (!url) throw new RecoveryError("no_database", "No database is configured.", "Set DATABASE_URL or pass --database-url.")
  const client = new Client({ connectionString: url })
  try {
    await client.connect()
  } catch (error) {
    throw new RecoveryError("database_unreachable", `Cannot connect to ${describeDatabase(url)}: ${(error as Error).message}.`, "Check the address, credentials and that the database is running.")
  }
  return { client, label: describeDatabase(url) }
}

const artifactDirectory = (parsed: Parsed, env: Env) => resolve(flag(parsed, "artifact-dir") ?? readProductEnv(env, "ARTIFACT_DIR")?.trim() ?? "./data/artifacts")

function printFindings(io: Io, findings: Finding[]) {
  for (const finding of findings) {
    io.out(`  ${finding.severity === "error" ? "ERROR  " : "warning"} [${finding.code}] ${finding.message}`)
    if (finding.action) io.out(`          → ${finding.action}`)
  }
}

function emit(io: Io, parsed: Parsed, value: unknown, text: () => void) {
  if (has(parsed, "json")) io.out(JSON.stringify(value, null, 2))
  else text()
}

async function prerequisites(parsed: Parsed, env: Env, io: Io) {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []
  const inventory = configurationInventory(env)
  const key = inventory.find((entry) => entry.name === "BETTER_AUTH_SECRET")!
  checks.push({ name: "BETTER_AUTH_SECRET", ok: key.set, detail: key.set ? "set" : "missing: set it to the source installation's value" })
  const dir = artifactDirectory(parsed, env)
  const dirOk = await stat(dir).then((s) => s.isDirectory(), () => false)
  checks.push({ name: "artifact directory", ok: true, detail: dirOk ? `${dir} exists` : `${dir} does not exist yet; it is created during restore` })
  let databaseOk = false
  try {
    const { client, label } = await connect(parsed, env)
    try {
      const query = queryFn(client)
      const applied = await readAppliedMigrations(query)
      const known = await knownMigrations()
      databaseOk = Boolean(applied?.length)
      checks.push({ name: "database", ok: true, detail: `${label}, PostgreSQL ${await readPostgresVersion(query)}` })
      checks.push({
        name: "database migrations",
        ok: Boolean(applied?.length) && known.every((name) => applied!.includes(name)),
        detail: applied?.length ? `${applied.length} applied, ${known.filter((name) => !applied.includes(name)).length} missing for this release` : "none applied: run `bunx prisma migrate deploy` first",
      })
    } finally {
      await client.end()
    }
  } catch (error) {
    checks.push({ name: "database", ok: false, detail: (error as Error).message })
  }
  const optional = inventory.filter((entry) => entry.name !== "BETTER_AUTH_SECRET" && entry.name !== "DATABASE_URL")
  emit(io, parsed, { checks, configuration: inventory }, () => {
    for (const check of checks) io.out(`${check.ok ? "ok     " : "MISSING"} ${check.name}: ${check.detail}`)
    io.out("\nSettings the source installation used (names only):")
    for (const entry of optional) io.out(`  ${entry.set ? "set    " : "not set"} ${entry.name} - ${entry.purpose}`)
  })
  return checks.every((check) => check.ok) && databaseOk ? 0 : 1
}

async function backupCreate(parsed: Parsed, env: Env, io: Io) {
  const out = flag(parsed, "out")
  if (!out) throw new RecoveryError("usage", "backup create needs --out DIR.")
  const { client, label } = await connect(parsed, env)
  try {
    const result = await createBackup({
      client,
      artifactStore: localDiskArtifactStore(artifactDirectory(parsed, env)),
      directory: resolve(out),
      env,
      appVersion: appVersion(),
      allowIncomplete: has(parsed, "allow-incomplete"),
      record: !has(parsed, "no-record"),
    })
    const check = await verifyBundle(result.directory)
    const errors = check.findings.filter((finding) => finding.severity === "error")
    emit(io, parsed, { directory: result.directory, manifestSha256: result.manifestSha256, findings: check.findings }, () => {
      const rows = result.manifest.database.tables.reduce((sum, table) => sum + table.rows, 0)
      io.out(`Backup of ${label} written to ${result.directory}`)
      io.out(`  ${result.manifest.database.tables.length} tables, ${rows} rows, ${result.manifest.artifacts.objects.length} artifacts, format ${result.manifest.formatVersion}, Quits ${result.manifest.source.appVersion}`)
      io.out(`  manifest SHA-256: ${result.manifestSha256}`)
      io.out("  Keep that digest somewhere other than the bundle: it detects a replaced bundle.")
      io.out("  The bundle holds password hashes and encrypted provider secrets. Store it as you would the database.")
      printFindings(io, check.findings)
    })
    return errors.length ? 1 : 0
  } finally {
    await client.end()
  }
}

async function backupVerify(parsed: Parsed, env: Env, io: Io) {
  const directory = parsed.positional[2]
  if (!directory) throw new RecoveryError("usage", "backup verify needs the bundle directory.")
  const check = await verifyBundle(resolve(directory))
  const errors = check.findings.filter((finding) => finding.severity === "error")
  if (has(parsed, "record") && !errors.length) {
    const { client } = await connect(parsed, env)
    try {
      await recordBackup(queryFn(client), "verified", check.manifest, check.manifestSha256)
    } finally {
      await client.end()
    }
  }
  emit(io, parsed, { manifestSha256: check.manifestSha256, filesChecked: check.filesChecked, findings: check.findings, source: check.manifest.source }, () => {
    io.out(`Bundle ${check.manifest.bundleId}: format ${check.manifest.formatVersion}, Quits ${check.manifest.source.appVersion}, taken ${check.manifest.createdAt}`)
    io.out(`  ${check.filesChecked} files, ${(check.bytesChecked / 1024).toFixed(0)} KiB checked against their SHA-256`)
    io.out(`  manifest SHA-256: ${check.manifestSha256}`)
    io.out(errors.length ? "  RESULT: FAILED" : "  RESULT: integrity verified")
    printFindings(io, check.findings)
  })
  return errors.length ? 1 : 0
}

async function restore(parsed: Parsed, env: Env, io: Io) {
  const bundle = parsed.positional[1]
  if (!bundle) throw new RecoveryError("usage", "restore needs the bundle directory.")
  const { client, label } = await connect(parsed, env)
  const options = {
    client,
    artifactStore: localDiskArtifactStore(artifactDirectory(parsed, env)),
    bundle: resolve(bundle),
    env,
    skipKeyCheck: has(parsed, "skip-key-check"),
    allowIncomplete: has(parsed, "allow-incomplete"),
    appVersion: appVersion(),
    knownMigrations: await knownMigrations(),
  }
  try {
    if (has(parsed, "dry-run")) {
      const preflight = await preflightRestore(options)
      emit(io, parsed, { restorable: preflight.restorable, findings: preflight.findings }, () => {
        io.out(`Preflight against ${label}: ${preflight.restorable ? "the bundle can be restored" : "the bundle CANNOT be restored yet"}`)
        printFindings(io, preflight.findings)
      })
      return preflight.restorable ? 0 : 1
    }
    const report = await restoreBundle(options)
    emit(io, parsed, report, () => {
      io.out(`Restored backup ${report.bundleId} (Quits ${report.sourceAppVersion}, taken ${report.backupCreatedAt}) into ${label}`)
      for (const [gate, result] of Object.entries(report.gates)) io.out(`  ${result === "pass" ? "pass   " : result === "skipped" ? "skipped" : "FAIL   "} ${gate}`)
      io.out(`  ${Object.values(report.rowCounts).reduce((sum, n) => sum + n, 0)} rows in ${Object.keys(report.rowCounts).length} tables; ${report.artifactsVerified} artifacts verified against their recorded hashes`)
      io.out(`  pending in the backup: ${report.pendingWork.jobsPending} jobs, ${report.pendingWork.remindersDue} reminders due, ${report.pendingWork.recurringDue} recurring invoices due`)
      for (const warning of report.warnings) io.out(`  warning ${warning}`)
      io.out("\nOperations are HELD. This installation sends no email, takes no payments, makes no AI calls and runs no scheduled work or jobs.")
      io.out("Review with `recovery review`; enable with `recovery enable-operations` only at cutover.")
    })
    return 0
  } finally {
    await client.end()
  }
}

async function status(parsed: Parsed, env: Env, io: Io) {
  const { client } = await connect(parsed, env)
  try {
    const result = await collectOperationalStatus({
      query: queryFn(client),
      env,
      artifactStore: localDiskArtifactStore(artifactDirectory(parsed, env)),
      environmentHold: environmentHold(env),
      artifactCheckLimit: has(parsed, "full") ? Number.MAX_SAFE_INTEGER : 2000,
    })
    emit(io, parsed, result, () => {
      io.out(`Operations: ${result.operations.held ? `HELD (${result.operations.source})` : "live"}`)
      io.out(`Backup: ${result.backups.ageHours === null ? "none recorded" : `${result.backups.ageHours} h old`}${result.backups.stale ? " (stale)" : ""}; last verified ${result.backups.lastVerifiedAt ?? "never"}`)
      io.out(`Artifacts: ${result.artifacts.checked} checked of ${result.artifacts.issuedDocuments} issued documents; ${result.artifacts.missingObjects} missing, ${result.artifacts.mismatched} corrupt${result.artifacts.truncated ? " (check limited; use --full)" : ""}`)
      io.out(`Scheduler: last tick ${result.scheduler.lastTickAt ?? "never"}; ${result.scheduler.pendingJobs} jobs pending, ${result.scheduler.failedJobs} failed`)
      io.out(`Mail: ${result.mail.provider} ${result.mail.configured ? "configured" : "NOT configured"}; ${result.mail.failedDeliveries7d} failed deliveries in 7 days`)
      for (const problem of result.problems) io.out(`  ${problem.severity === "error" ? "ERROR  " : "warning"} [${problem.code}] ${problem.message}`)
      if (!result.problems.length) io.out("No problems found.")
    })
    return result.ok ? 0 : 1
  } finally {
    await client.end()
  }
}

async function review(parsed: Parsed, env: Env, io: Io) {
  const { client } = await connect(parsed, env)
  try {
    const result = await reviewPendingWork(queryFn(client))
    const token = reviewToken(result)
    emit(io, parsed, { ...result, reviewToken: token }, () => {
      io.out(result.restoredFrom ? `Restored from backup ${result.restoredFrom.bundleId} (Quits ${result.restoredFrom.appVersion}, taken ${result.restoredFrom.createdAt})` : "This installation was not restored by the recovery tool.")
      if (result.gates) io.out(`Verification: ${Object.entries(result.gates).map(([gate, outcome]) => `${gate} ${outcome}`).join(", ")}`)
      io.out("\nQueued work that will run once operations are enabled:")
      if (!result.jobs.length) io.out("  no queued jobs")
      for (const job of result.jobs) io.out(`  ${job.count} ${job.status} ${job.type}${job.withPriorAttempts ? ` (${job.withPriorAttempts} already attempted)` : ""}`)
      io.out(`  ${result.remindersDue} reminders due, ${result.recurringDue} recurring invoices due, ${result.eventDeliveriesPending} event deliveries pending`)
      io.out("\nDuplicate-execution controls:")
      for (const control of result.duplicateExecutionControls) io.out(`  - ${control}`)
      for (const warning of result.warnings) io.out(`\nWARNING: ${warning}`)
      io.out(`\nReview token: ${token}`)
    })
    return 0
  } finally {
    await client.end()
  }
}

async function enable(parsed: Parsed, env: Env, io: Io) {
  const token = flag(parsed, "review-token")
  const jobs = flag(parsed, "jobs")
  if (!token) throw new RecoveryError("usage", "enable-operations needs --review-token from `recovery review`.")
  if (jobs !== "keep" && jobs !== "cancel") throw new RecoveryError("usage", "enable-operations needs --jobs keep or --jobs cancel.", "Decide what happens to the queued jobs shown by `recovery review`.")
  const { client } = await connect(parsed, env)
  try {
    const result = await enableOperations({
      client,
      reviewToken: token,
      jobs,
      sourceStopped: has(parsed, "source-stopped"),
      acceptedGates: (parsed.flags.get("accept-gate") ?? []) as GateName[],
    })
    emit(io, parsed, result, () => {
      io.out(`Operations enabled${result.cancelledJobs ? `; ${result.cancelledJobs} queued job(s) cancelled` : ""}.`)
      if (environmentHold(env)) io.out("QUITS_OPERATIONS_HOLD is still set in this shell's environment; unset it on the app and scheduler too.")
      io.out("The next scheduler tick resumes reminders, recurring invoices and queued jobs.")
    })
    return 0
  } finally {
    await client.end()
  }
}

/** Runs one command; returns the process exit code. */
export async function runCli(argv: string[], env: Env, io: Io): Promise<number> {
  try {
    const parsed = parseArgs(argv)
    const [command, sub] = parsed.positional
    if (!command || has(parsed, "help")) {
      io.out(USAGE)
      return command ? 0 : 2
    }
    if (command === "prerequisites") return await prerequisites(parsed, env, io)
    if (command === "backup" && sub === "create") return await backupCreate(parsed, env, io)
    if (command === "backup" && sub === "verify") return await backupVerify(parsed, env, io)
    if (command === "restore") return await restore(parsed, env, io)
    if (command === "status") return await status(parsed, env, io)
    if (command === "review") return await review(parsed, env, io)
    if (command === "enable-operations") return await enable(parsed, env, io)
    io.err(`Unknown command: ${argv.join(" ")}\n\n${USAGE}`)
    return 2
  } catch (error) {
    if (error instanceof RestoreBlockedError) {
      io.err(`${error.message}`)
      printFindings({ out: io.err, err: io.err }, error.findings)
      return 1
    }
    if (error instanceof RecoveryError) {
      io.err(`${error.code === "usage" ? "" : "Error: "}${error.message}`)
      return error.code === "usage" ? 2 : 1
    }
    io.err(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2), process.env, { out: (text) => console.log(text), err: (text) => console.error(text) })
}
