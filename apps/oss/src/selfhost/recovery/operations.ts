import { createHash } from "node:crypto"
import type { Client } from "pg"
import { EXCLUDED_TABLES, RecoveryError } from "../../lib/recovery/format"
import { instant, queryFn, quoteIdent, readTables, utcNow, utcParam, type QueryFn, type TableInfo } from "../../lib/recovery/pgdb"
import type { GateName, RestoreReport } from "./restore"

export type PendingWorkReview = {
  /** SHA-256 of durable rows and schema; no customer payloads are displayed. */
  workDigest: string
  restoredFrom: { bundleId: string; createdAt: string; appVersion: string } | null
  gates: RestoreReport["gates"] | null
  jobs: Array<{ type: string; status: string; count: number; withPriorAttempts: number; oldestRunAfter: string | null }>
  remindersDue: number
  recurringDue: number
  eventDeliveriesPending: number
  /** What prevents the same work from running twice, in the terms an operator can act on. */
  duplicateExecutionControls: string[]
  warnings: string[]
}

const CONTROLS = [
  "Reminders: one row per invoice and offset; a reminder that already has a sent time is never sent again.",
  "Recurring invoices: one invoice per schedule and run date is enforced by the database.",
  "Queued jobs: a job with a dedupe key can exist only once; a job that was `running` at backup time is reclaimed after 15 minutes and retried.",
  "Email: Resend drops a repeat of the same idempotency key for 23 hours; SMTP cannot deduplicate, so an email whose first attempt may have reached the relay is not retried.",
  "Nothing prevents two installations from running the same schedule: stop the source scheduler before enabling operations here.",
]

/**
 * Review in a consistent snapshot. The query must use one dedicated connection, outside a
 * transaction. Cutover collects the same review inside its own transaction after locking writers.
 */
export async function reviewPendingWork(query: QueryFn): Promise<PendingWorkReview> {
  await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
  try {
    const review = await collectReview(query, await reviewTables(query))
    await query("COMMIT")
    return review
  } catch (error) {
    await query("ROLLBACK").catch(() => undefined)
    throw error
  }
}

async function reviewTables(query: QueryFn) {
  const tables = (await readTables(query)).filter((table) => !(table.name in EXCLUDED_TABLES))
  if (!["job", "invoice_reminder", "recurring_invoice", "event_consumer_delivery"].every((name) => tables.some((table) => table.name === name))) {
    throw new RecoveryError("review_schema_missing", "The recovery review needs a fully migrated database.", "Apply this release's migrations before reviewing or enabling operations.")
  }
  return tables
}

/**
 * Include all durable rows, not only due work: recipients, invoice revisions, recurrence terms,
 * reminder eligibility and future delivery tables can change what runs. Hash canonical PostgreSQL
 * JSON so exact numerics are retained. Only row hashes cross this query boundary.
 */
async function workDigest(query: QueryFn, tables: TableInfo[]) {
  const hash = createHash("sha256")
  for (const table of tables) {
    hash.update(JSON.stringify(table))
    await query(`DECLARE review_cursor NO SCROLL CURSOR FOR SELECT encode(sha256(convert_to(to_jsonb(t)::text, 'UTF8')), 'hex') AS digest FROM ${quoteIdent(table.name)} t ORDER BY digest`)
    for (;;) {
      const rows = await query("FETCH 500 FROM review_cursor")
      if (!rows.length) break
      for (const row of rows) hash.update(String(row.digest))
    }
    await query("CLOSE review_cursor")
  }
  return hash.digest("hex")
}

async function collectReview(query: QueryFn, tables: TableInfo[]): Promise<PendingWorkReview> {
  const state = (await query(`SELECT "restoredFrom", "restoreReport" FROM recovery_state WHERE id = 'default'`))[0]
  const report = (state?.restoreReport ?? null) as RestoreReport | null
  const restoredFrom = (state?.restoredFrom ?? null) as PendingWorkReview["restoredFrom"]
  const jobs = await query(`
    SELECT type, status, count(*)::int AS n, count(*) FILTER (WHERE attempts > 0)::int AS prior, min(${instant('"runAfter"')}) AS oldest
    FROM job WHERE status IN ('pending','running') GROUP BY type, status ORDER BY type, status`)
  const scalar = async (sql: string) => Number((await query(sql))[0]?.n ?? 0)
  const review: PendingWorkReview = {
    workDigest: await workDigest(query, tables),
    restoredFrom,
    gates: report?.gates ?? null,
    jobs: jobs.map((row) => ({
      type: String(row.type),
      status: String(row.status),
      count: Number(row.n),
      withPriorAttempts: Number(row.prior),
      oldestRunAfter: row.oldest instanceof Date ? row.oldest.toISOString() : row.oldest ? String(row.oldest) : null,
    })),
    remindersDue: await scalar(`SELECT count(*)::int AS n FROM invoice_reminder WHERE "sentAt" IS NULL AND "scheduledFor" <= ${utcNow}`),
    recurringDue: await scalar(`SELECT count(*)::int AS n FROM recurring_invoice WHERE status = 'active' AND "nextRunAt" <= ${utcNow}`),
    eventDeliveriesPending: await scalar(`SELECT count(*)::int AS n FROM event_consumer_delivery WHERE status IN ('pending','claimed')`),
    duplicateExecutionControls: CONTROLS,
    warnings: [],
  }
  if (review.recurringDue > 0) {
    review.warnings.push(
      "A recurring schedule that is due generates every run it missed on the next tick (the app's normal catch-up), not just one. Pause schedules you do not want to catch up before enabling operations."
    )
  }
  if (review.remindersDue > 0) {
    review.warnings.push("Reminders that came due while the installation was down are sent on the next tick, if the invoice is still unpaid.")
  }
  if (review.jobs.some((job) => job.status === "running")) {
    review.warnings.push("Jobs were running when the backup was taken. The source may have completed them; cancel them unless you are sure it did not.")
  }
  if (review.jobs.some((job) => job.type === "email.deliver" && job.withPriorAttempts > 0)) {
    review.warnings.push("Some queued emails were already attempted at least once. After the 23-hour idempotency window a retry could send a duplicate.")
  }
  return review
}

/** Changes whenever the pending work changes, so approval always refers to what was reviewed. */
export function reviewToken(review: PendingWorkReview) {
  const { workDigest, restoredFrom, gates, jobs, remindersDue, recurringDue, eventDeliveriesPending } = review
  return createHash("sha256")
    .update(JSON.stringify({ workDigest, restoredFrom, gates, jobs, remindersDue, recurringDue, eventDeliveriesPending }))
    .digest("hex")
}

export type EnableOptions = {
  client: Client
  reviewToken: string
  /** What to do with queued and running jobs; there is deliberately no default. */
  jobs: "keep" | "cancel"
  /** The operator asserts the source installation's scheduler and workers are stopped. */
  sourceStopped: boolean
  /** Gates whose failure or skip the operator knowingly accepts. */
  acceptedGates?: readonly GateName[]
  now?: Date
}

/**
 * The only way out of a held restore. It requires a review token for the work as it stands now,
 * an explicit choice for queued jobs, a statement that the source is stopped, and passing gates.
 */
export async function enableOperations(options: EnableOptions) {
  const query = queryFn(options.client)
  const now = options.now ?? new Date()
  await options.client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
  try {
    // Ordinary INSERT/UPDATE/DELETE acquire ROW EXCLUSIVE, which conflicts with these locks.
    // NOWAIT refuses an in-flight writer instead of waiting or risking a lock-upgrade deadlock.
    // Lock recovery_state first to serialize cutovers; keep every lock until COMMIT/ROLLBACK.
    await query("LOCK TABLE recovery_state IN SHARE ROW EXCLUSIVE MODE NOWAIT")
    const tables = await reviewTables(query)
    await query(`LOCK TABLE ${tables.map((table) => quoteIdent(table.name)).join(", ")} IN SHARE ROW EXCLUSIVE MODE NOWAIT`)
    const state = (await query(`SELECT "operationsMode", "restoreReport" FROM recovery_state WHERE id = 'default'`))[0]
    if (!state || state.operationsMode === "live") {
      throw new RecoveryError("not_held", "Operations are not on hold; nothing to enable.")
    }
    const report = state.restoreReport as RestoreReport | null
    const accepted = new Set(options.acceptedGates ?? [])
    const failing = report
      ? (Object.entries(report.gates) as Array<[GateName, string]>).filter(([name, result]) => result !== "pass" && !accepted.has(name))
      : [["integrity", "unknown"] as [GateName, string]]
    if (failing.length) {
      throw new RecoveryError(
        "gates_not_passed",
        `Verification did not pass for: ${failing.map(([name, result]) => `${name} (${result})`).join(", ")}.`,
        "Restore again after fixing the cause. To proceed anyway, name each gate with --accept-gate <name>."
      )
    }
    if (!options.sourceStopped) {
      throw new RecoveryError("source_not_confirmed", "Confirm that the source installation's scheduler and workers are stopped.", "Stop them, then pass --source-stopped.")
    }
    const review = await collectReview(query, tables)
    if (options.reviewToken !== reviewToken(review)) {
      throw new RecoveryError("review_stale", "The review token does not match the pending work as it is now.", "Run `recovery review` again, read it, and pass the new token.")
    }

    const cutover = accepted.size ? "acknowledged_exception" : "verified"
    let cancelled = 0
    if (options.jobs === "cancel") {
      const result = await options.client.query(
        `UPDATE job SET status = 'failed', "claimToken" = NULL, "lastError" = 'Cancelled at cutover after restore', "updatedAt" = ${utcParam(1)} WHERE status IN ('pending','running')`,
        [now]
      )
      cancelled = result.rowCount ?? 0
    }
    await options.client.query(
      `UPDATE recovery_state SET "operationsMode" = 'live', "heldReason" = NULL, "enabledAt" = ${utcParam(1)}, "updatedAt" = ${utcParam(1)},
         "restoreReport" = jsonb_set(coalesce("restoreReport", '{}'::jsonb), '{enabled}', $2::jsonb) WHERE id = 'default'`,
      [now, JSON.stringify({ at: now.toISOString(), jobs: options.jobs, cancelled, acceptedGates: [...accepted], cutover, reviewToken: options.reviewToken })]
    )
    await options.client.query("COMMIT")
    return { cancelledJobs: cancelled, cutover, acceptedGates: [...accepted] }
  } catch (error) {
    await options.client.query("ROLLBACK").catch(() => undefined)
    if ((error as { code?: string }).code === "55P03") {
      throw new RecoveryError("cutover_busy", "A database writer is active; operations remain held.", "Stop application writers and migrations, then review pending work and retry cutover.")
    }
    throw error
  }
}
