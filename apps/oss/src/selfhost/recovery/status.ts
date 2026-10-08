import { readBooleanEnv, readProductEnv } from "@quits/shared/runtimeEnv"
import type { DocumentArtifactStore } from "../../lib/runtime/services"
import { readSmtpConfiguration } from "../../lib/email-provider-config"
import { ARTIFACT_OWNERS } from "./format"
import { quoteIdent, type QueryFn } from "./pgdb"

type Env = Record<string, string | undefined>

export type StatusProblem = { severity: "error" | "warning"; code: string; message: string }

export type OperationalStatus = {
  generatedAt: string
  /** True when nothing needs an operator's attention. */
  ok: boolean
  operations: { held: boolean; source: "environment" | "database" | null; reason: string | null; heldAt: string | null; enabledAt: string | null }
  backups: { lastCreatedAt: string | null; lastVerifiedAt: string | null; ageHours: number | null; maxAgeHours: number; stale: boolean }
  artifacts: { issuedDocuments: number; checked: number; withoutReference: number; missingObjects: number; mismatched: number; truncated: boolean }
  scheduler: {
    lastTickAt: string | null
    lastTickOk: boolean | null
    ageMinutes: number | null
    stale: boolean
    pendingJobs: number
    overdueJobs: number
    failedJobs: number
    oldestPendingMinutes: number | null
    remindersDue: number
    recurringDue: number
  }
  mail: { provider: "resend" | "smtp"; configured: boolean; senderConfigured: boolean; failedDeliveries7d: number; retryingDeliveries: number; lastAttemptAt: string | null }
  problems: StatusProblem[]
}

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value ? new Date(String(value)).toISOString() : null)
const minutes = (from: Date | null, now: Date) => (from ? Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000)) : null)

export type StatusOptions = {
  query: QueryFn
  env: Env
  artifactStore?: DocumentArtifactStore
  /** Whether the hold comes from the environment; the database state is read here. */
  environmentHold: boolean
  /** Artifact objects to check in the store, newest documents first. 0 skips the object check. */
  artifactCheckLimit?: number
  now?: Date
}

/**
 * Backup age, artifact completeness, scheduler and mail health for one installation. Reads only;
 * never contacts the mail provider or any payment provider.
 */
export async function collectOperationalStatus(options: StatusOptions): Promise<OperationalStatus> {
  const { query, env } = options
  const now = options.now ?? new Date()
  const scalar = async (sql: string, params?: unknown[]) => Number((await query(sql, params))[0]?.n ?? 0)
  const problems: StatusProblem[] = []

  const state = (await query(`SELECT "operationsMode", "heldReason", "heldAt", "enabledAt", "lastSchedulerTickAt", "lastSchedulerTickOk" FROM recovery_state WHERE id = 'default'`))[0]
  const heldByDatabase = Boolean(state && state.operationsMode !== "live")
  const operations: OperationalStatus["operations"] = {
    held: options.environmentHold || heldByDatabase,
    source: options.environmentHold ? "environment" : heldByDatabase ? "database" : null,
    reason: options.environmentHold ? "QUITS_OPERATIONS_HOLD is set on this instance." : heldByDatabase ? String(state?.heldReason ?? "") || null : null,
    heldAt: heldByDatabase ? iso(state?.heldAt) : null,
    enabledAt: iso(state?.enabledAt),
  }
  if (operations.held) {
    problems.push({ severity: "warning", code: "operations_held", message: `Operations are on hold: no email, payments, AI calls, scheduled work or queued jobs run. ${operations.reason ?? ""}`.trim() })
  }

  // Backups.
  const maxAgeHours = Number(readProductEnv(env, "BACKUP_MAX_AGE_HOURS")) || 48
  const records = await query(`SELECT kind, max("createdAt") AS at FROM backup_record GROUP BY kind`)
  const lastOf = (kind: string) => {
    const at = records.find((row) => row.kind === kind)?.at
    return at ? new Date(String(at instanceof Date ? at.toISOString() : at)) : null
  }
  const created = lastOf("created")
  const verified = lastOf("verified")
  const newest = [created, verified].filter((date): date is Date => Boolean(date)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null
  const ageHours = newest ? Math.round(((now.getTime() - newest.getTime()) / 3_600_000) * 10) / 10 : null
  const backups: OperationalStatus["backups"] = {
    lastCreatedAt: created?.toISOString() ?? null,
    lastVerifiedAt: verified?.toISOString() ?? null,
    ageHours,
    maxAgeHours,
    stale: ageHours === null || ageHours > maxAgeHours,
  }
  if (ageHours === null) problems.push({ severity: "warning", code: "no_backup", message: "No backup has been recorded for this installation. Run `recovery backup create`." })
  else if (backups.stale) problems.push({ severity: "warning", code: "backup_stale", message: `The newest recorded backup is ${ageHours} hours old (limit ${maxAgeHours}).` })

  // Artifacts.
  const artifacts: OperationalStatus["artifacts"] = { issuedDocuments: 0, checked: 0, withoutReference: 0, missingObjects: 0, mismatched: 0, truncated: false }
  const limit = options.artifactCheckLimit ?? 2000
  for (const owner of ARTIFACT_OWNERS) {
    if (owner.table === "agreement") continue
    const issued = owner.table === "invoice" ? `WHERE status <> 'draft'` : ""
    artifacts.issuedDocuments += await scalar(`SELECT count(*)::int AS n FROM ${quoteIdent(owner.table)} ${issued}`)
    artifacts.withoutReference += await scalar(`SELECT count(*)::int AS n FROM ${quoteIdent(owner.table)} ${issued ? `${issued} AND` : "WHERE"} "artifactPdfRef" IS NULL`)
    if (!options.artifactStore || limit <= 0) continue
    const rows = await query(
      `SELECT "artifactPdfRef" AS ref, "artifactPdfHash" AS hash, "artifactUblRef" AS ubl_ref, "artifactUblHash" AS ubl_hash FROM ${quoteIdent(owner.table)} ${issued}
       ${issued ? "AND" : "WHERE"} ("artifactPdfRef" IS NOT NULL OR "artifactUblRef" IS NOT NULL) ORDER BY "createdAt" DESC LIMIT $1`,
      [limit - artifacts.checked + 1]
    )
    for (const row of rows) {
      for (const [ref, hash] of [[row.ref, row.hash], [row.ubl_ref, row.ubl_hash]] as const) {
        if (!ref) continue
        if (artifacts.checked >= limit) {
          artifacts.truncated = true
          break
        }
        artifacts.checked += 1
        try {
          const meta = await options.artifactStore.head(String(ref))
          if (!meta) artifacts.missingObjects += 1
          else if (hash && meta.hash !== hash) artifacts.mismatched += 1
        } catch {
          artifacts.mismatched += 1
        }
      }
    }
  }
  if (artifacts.missingObjects) problems.push({ severity: "error", code: "artifacts_missing", message: `${artifacts.missingObjects} issued document artifact(s) are missing from the artifact store.` })
  if (artifacts.mismatched) problems.push({ severity: "error", code: "artifacts_corrupt", message: `${artifacts.mismatched} issued document artifact(s) do not match their recorded hash.` })
  if (artifacts.withoutReference) problems.push({ severity: "warning", code: "artifacts_unrecorded", message: `${artifacts.withoutReference} issued document(s) have no stored artifact (legacy documents are expected to).` })

  // Scheduler.
  const lastTick = state?.lastSchedulerTickAt ? new Date(String(state.lastSchedulerTickAt instanceof Date ? state.lastSchedulerTickAt.toISOString() : state.lastSchedulerTickAt)) : null
  const tickMinutes = minutes(lastTick, now)
  const oldest = (await query(`SELECT min("runAfter") AS at FROM job WHERE status = 'pending' AND "runAfter" <= $1`, [now]))[0]?.at
  const scheduler: OperationalStatus["scheduler"] = {
    lastTickAt: lastTick?.toISOString() ?? null,
    lastTickOk: typeof state?.lastSchedulerTickOk === "boolean" ? state.lastSchedulerTickOk : null,
    ageMinutes: tickMinutes,
    stale: tickMinutes === null || tickMinutes > 30,
    pendingJobs: await scalar(`SELECT count(*)::int AS n FROM job WHERE status = 'pending'`),
    overdueJobs: await scalar(`SELECT count(*)::int AS n FROM job WHERE status = 'pending' AND "runAfter" <= $1 - interval '30 minutes'`, [now]),
    failedJobs: await scalar(`SELECT count(*)::int AS n FROM job WHERE status = 'failed'`),
    oldestPendingMinutes: oldest ? minutes(new Date(String(oldest instanceof Date ? oldest.toISOString() : oldest)), now) : null,
    remindersDue: await scalar(`SELECT count(*)::int AS n FROM invoice_reminder WHERE "sentAt" IS NULL AND "scheduledFor" <= $1`, [now]),
    recurringDue: await scalar(`SELECT count(*)::int AS n FROM recurring_invoice WHERE status = 'active' AND "nextRunAt" <= $1`, [now]),
  }
  if (!operations.held) {
    if (scheduler.stale) problems.push({ severity: "error", code: "scheduler_silent", message: scheduler.lastTickAt ? `The scheduler last ran ${tickMinutes} minutes ago. Check that the scheduler service is running and CRON_SECRET matches.` : "The scheduler has never run. Start the scheduler service (docker compose runs it) and check CRON_SECRET." })
    else if (scheduler.lastTickOk === false) problems.push({ severity: "error", code: "scheduler_failing", message: "The last scheduler tick reported failed tasks. See the tick response and the application log." })
    if (scheduler.overdueJobs) problems.push({ severity: "warning", code: "jobs_overdue", message: `${scheduler.overdueJobs} queued job(s) have been due for more than 30 minutes.` })
  }
  if (scheduler.failedJobs) problems.push({ severity: "warning", code: "jobs_failed", message: `${scheduler.failedJobs} job(s) failed permanently and need a person.` })

  // Mail: configuration and the outcomes of earlier deliveries. No request is made to the provider.
  const provider = env.EMAIL_PROVIDER === "smtp" ? "smtp" : "resend"
  let configured: boolean
  if (provider === "smtp") {
    try {
      readSmtpConfiguration(env)
      configured = true
    } catch {
      configured = false
    }
  } else {
    configured = Boolean(env.RESEND_API_KEY?.trim())
  }
  const attempt = (await query(`SELECT max("lastEmailAttemptAt") AS at FROM invoice`))[0]?.at
  const mail: OperationalStatus["mail"] = {
    provider,
    configured,
    senderConfigured: Boolean(env.FROM_EMAIL?.trim()),
    failedDeliveries7d: await scalar(`SELECT count(*)::int AS n FROM job WHERE type = 'email.deliver' AND status = 'failed' AND "updatedAt" >= $1 - interval '7 days'`, [now]),
    retryingDeliveries: await scalar(`SELECT count(*)::int AS n FROM job WHERE type = 'email.deliver' AND status = 'pending' AND attempts > 0`),
    lastAttemptAt: attempt ? iso(attempt) : null,
  }
  if (!configured) problems.push({ severity: "error", code: "mail_not_configured", message: provider === "smtp" ? "EMAIL_PROVIDER=smtp but SMTP_HOST (and related settings) are not set." : "RESEND_API_KEY is not set, so no email can be sent." })
  if (configured && !mail.senderConfigured) problems.push({ severity: "warning", code: "mail_sender_missing", message: "FROM_EMAIL is not set; messages would use the default sender address." })
  if (mail.failedDeliveries7d) problems.push({ severity: "warning", code: "mail_failures", message: `${mail.failedDeliveries7d} email delivery job(s) failed in the last 7 days.` })

  return {
    generatedAt: now.toISOString(),
    ok: !problems.some((problem) => problem.severity === "error"),
    operations,
    backups,
    artifacts,
    scheduler,
    mail,
    problems,
  }
}

export function environmentHold(env: Env) {
  return readBooleanEnv(readProductEnv(env, "OPERATIONS_HOLD"), false)
}
