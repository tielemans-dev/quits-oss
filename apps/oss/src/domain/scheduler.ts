import { randomUUID } from "node:crypto"
import { Prisma } from "../../generated/prisma/client"
import { prisma } from "../lib/db"
import { isOperationsHeld } from "../lib/operations-hold"
import { appLogger } from "../lib/observability"
import { DEFAULT_JOBS_PER_SWEEP, runDueJobs } from "./jobs"

const schedulerLogger = appLogger.child("scheduler")

export type TickOptions = {
  /**
   * Restricts every task to these organizations. Production ticks pass none; tests pass their
   * own organizations so they never act on data other tests share the database with.
   */
  organizationIds?: readonly string[]
}

export type TickTask = {
  name: string
  /** Lower runs first. Overdue marking must run before reminders read invoice status. */
  order: number
  run: (now: Date, options?: TickOptions) => Promise<Record<string, number>>
}

/** Queued jobs swept per tick; the rest run on the next tick. */
const JOBS_PER_TICK = DEFAULT_JOBS_PER_SWEEP

/** Runs due jobs of specific organizations, oldest first, within the jobs time budget. */
export async function runOrganizationJobs(
  organizationIds: readonly string[],
  now: Date = new Date(),
  limit = JOBS_PER_TICK
) {
  return runDueJobs({ now, limit, organizationIds })
}

/**
 * Sends every queued delivery (reminders, recurring auto-sends) and other background work. Its
 * time budget bounds how long a tick spends emailing; jobs not started stay queued.
 */
const tasks: TickTask[] = [
  {
    name: "jobs",
    order: 1000,
    run: async (now, options) =>
      runDueJobs({ now, limit: JOBS_PER_TICK, organizationIds: options?.organizationIds }),
  },
]

export function registerTickTask(task: TickTask) {
  const existing = tasks.findIndex((candidate) => candidate.name === task.name)
  if (existing >= 0) {
    tasks.splice(existing, 1)
  }
  tasks.push(task)
}

/**
 * Runs every scheduled task once. Each task must be idempotent: ticks can overlap or be
 * retried, and a failed task never stops the others.
 */
export async function runSchedulerTick(now = new Date(), options: TickOptions = {}) {
  // Overdue marking, reminders, recurring invoices and jobs all wait until operations are enabled.
  if (await isOperationsHeld()) {
    return { operationsHold: { held: 1 } } as Record<string, Record<string, number> | { error: string }>
  }
  const results: Record<string, Record<string, number> | { error: string }> = {}

  for (const task of [...tasks].sort((a, b) => a.order - b.order)) {
    try {
      results[task.name] = await task.run(now, options)
    } catch (error) {
      results[task.name] = { error: error instanceof Error ? error.message : String(error) }
      schedulerLogger.error("scheduler.task_failed", { task: task.name, error })
    }
  }

  return results
}

/** Per-tick limits for tasks that work through organizations one command at a time. */
export type OrganizationBudget = {
  /** Organizations a task processes per tick. */
  maxOrganizations: number
  /**
   * A task starts no new organization after this long. It counts from the start of the task,
   * so discovering and claiming organizations use it up too.
   */
  timeBudgetMs: number
  /**
   * Newly eligible organizations a tick registers for scanning. Defaults to half of
   * `maxOrganizations`, so while a large wave of new organizations is being registered, the
   * other half of every tick still goes to organizations that were registered before.
   */
  maxRegistrations?: number
}

export const DEFAULT_ORGANIZATION_BUDGET: OrganizationBudget = {
  maxOrganizations: 200,
  timeBudgetMs: 45_000,
}

/**
 * How long a claim outlives the time budget. The last organization a tick starts may run past the
 * budget; until its claim expires no other tick claims it.
 */
export const CLAIM_LEASE_MARGIN_MS = 5 * 60_000

export type ClaimOptions = {
  /** How long the claimed organizations stay reserved for this claim. */
  leaseMs: number
  /** Newly eligible organizations registered for scanning before claiming. */
  maxRegistrations: number
}

/**
 * Organizations one tick holds. Other ticks do not claim them until the claim is finished,
 * released or expires. Finishing and releasing only act on organizations this claim still holds,
 * so a claim that expired and was taken over cannot undo the newer claim.
 */
export type OrganizationClaim = {
  organizationIds: string[]
  /** The tick is done with these organizations; they keep their scan time. */
  finish: (organizationIds: readonly string[]) => Promise<void>
  /** The tick did not reach these organizations; they go first next time. */
  release: (organizationIds: readonly string[]) => Promise<void>
}

/**
 * The organizations a task may work on. `claim` registers a bounded number of newly eligible
 * organizations, then hands out the least recently scanned eligible organizations no live claim
 * holds and records that they were scanned, so successive ticks work through every eligible
 * organization whatever their cadence or the time they pass.
 */
export type OrganizationSource = {
  count: () => Promise<number>
  claim: (limit: number, options: ClaimOptions) => Promise<OrganizationClaim>
}

/** The database clock as UTC, matching how Prisma stores `TIMESTAMP(3)` columns. */
const databaseNow = Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`

/**
 * An organization source backed by `scheduler_scan`, which keeps when `task` last claimed each
 * organization and which claim holds it. `eligible` is a query returning an `"organizationId"`
 * column (repeats allowed).
 *
 * Organizations that became eligible are registered at most `maxRegistrations` per claim, lowest
 * id first; registered organizations are no longer missing, so every eligible organization is
 * registered within ceil(new / maxRegistrations) claims. Claims order by the last scan,
 * longest-waiting first (an organization waits from its last scan, or from when it became
 * eligible), so the rotation is durable across restarts and independent of the tick
 * cadence or clock. A claim stamps its rows with a token and an expiry; other claims skip rows with
 * a live claim and rows another transaction is claiming (`FOR UPDATE SKIP LOCKED`). Times come
 * from the database clock, never from the tick's `now`.
 */
export function scannedOrganizationSource(task: string, eligible: Prisma.Sql): OrganizationSource {
  const forClaim = (token: string, organizationIds: readonly string[]) => Prisma.sql`
    "task" = ${task}
    AND "claimToken" = ${token}
    AND "organizationId" IN (${Prisma.join([...organizationIds])})
  `
  return {
    count: async () => {
      const [row] = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT e."organizationId") AS "count" FROM (${eligible}) e
      `
      return Number(row?.count ?? 0)
    },
    claim: async (limit, { leaseMs, maxRegistrations }) => {
      if (maxRegistrations > 0) {
        // Organizations that became eligible join the queue as waiting since now, behind every
        // organization that has waited longer, so a stream of newcomers cannot postpone existing
        // organizations at any budget. The anti-join makes this an index lookup per eligible
        // organization when none is missing.
        await prisma.$executeRaw`
          INSERT INTO "scheduler_scan" ("task", "organizationId", "scannedAt")
          SELECT ${task}, m."organizationId", ${databaseNow} FROM (
            SELECT DISTINCT e."organizationId" FROM (${eligible}) e
            WHERE NOT EXISTS (
              SELECT 1 FROM "scheduler_scan" s
              WHERE s."task" = ${task} AND s."organizationId" = e."organizationId"
            )
            ORDER BY e."organizationId" ASC
            LIMIT ${maxRegistrations}
          ) m
          ON CONFLICT ("task", "organizationId") DO NOTHING
        `
      }
      const token = randomUUID()
      const rows = await prisma.$queryRaw<Array<{ organizationId: string; previousScannedAt: Date | null }>>`
        WITH candidates AS (
          SELECT s."organizationId", s."scannedAt"
          FROM "scheduler_scan" s
          WHERE s."task" = ${task}
            AND (s."claimedUntil" IS NULL OR s."claimedUntil" < ${databaseNow})
            AND s."organizationId" IN (SELECT e."organizationId" FROM (${eligible}) e)
          ORDER BY s."scannedAt" ASC NULLS FIRST, s."organizationId" ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "scheduler_scan" s
        SET "scannedAt" = ${databaseNow},
            "claimToken" = ${token},
            "claimedUntil" = ${databaseNow} + ${Math.max(0, Math.round(leaseMs))}::integer * INTERVAL '1 millisecond'
        FROM candidates c
        WHERE s."task" = ${task} AND s."organizationId" = c."organizationId"
        RETURNING s."organizationId", c."scannedAt" AS "previousScannedAt"
      `
      // RETURNING has no order; work oldest first so a time budget cuts the most recently scanned.
      const organizationIds = rows
        .sort(
          (a, b) =>
            (a.previousScannedAt?.getTime() ?? -Infinity) - (b.previousScannedAt?.getTime() ?? -Infinity) ||
            a.organizationId.localeCompare(b.organizationId)
        )
        .map((row) => row.organizationId)

      return {
        organizationIds,
        finish: async (finished) => {
          if (finished.length === 0) return
          await prisma.$executeRaw`
            UPDATE "scheduler_scan" SET "claimToken" = NULL, "claimedUntil" = NULL
            WHERE ${forClaim(token, finished)}
          `
        },
        // Unreached organizations keep their place in the queue, so they go first next tick.
        release: async (unreached) => {
          for (const organizationId of unreached) {
            const previous = rows.find((row) => row.organizationId === organizationId)?.previousScannedAt ?? null
            // The column holds UTC wall-clock time without a zone.
            const scannedAt = previous
              ? Prisma.sql`(${previous.toISOString()}::timestamptz AT TIME ZONE 'UTC')`
              : Prisma.sql`NULL`
            await prisma.$executeRaw`
              UPDATE "scheduler_scan" SET "scannedAt" = ${scannedAt}, "claimToken" = NULL, "claimedUntil" = NULL
              WHERE ${forClaim(token, [organizationId])}
            `
          }
        },
      }
    },
  }
}

/**
 * Runs `work` for the organizations `source` claims, least recently scanned first, until the
 * task's per-tick budget is used up. Claimed organizations the time budget left unreached are
 * released and go first next tick. Every registered eligible organization is reached within
 * ceil(eligible / maxOrganizations) ticks of a full budget, and combined with a bounded amount of
 * work per organization, a tick finishes in bounded time however large the backlog is.
 */
export async function forEachOrganizationWithinBudget(
  source: OrganizationSource,
  work: (organizationId: string) => Promise<void>,
  budget: OrganizationBudget = DEFAULT_ORGANIZATION_BUDGET
) {
  const startedAt = Date.now()
  const total = await source.count()
  if (total === 0) {
    return { organizations: 0, processed: 0, deferred: 0 }
  }

  const claim = await source.claim(budget.maxOrganizations, {
    leaseMs: budget.timeBudgetMs + CLAIM_LEASE_MARGIN_MS,
    maxRegistrations: budget.maxRegistrations ?? Math.max(1, Math.floor(budget.maxOrganizations / 2)),
  })
  const { organizationIds } = claim
  let processed = 0
  try {
    while (
      processed < organizationIds.length &&
      (processed === 0 || Date.now() - startedAt < budget.timeBudgetMs)
    ) {
      await work(organizationIds[processed]!)
      processed += 1
    }
  } finally {
    await claim.finish(organizationIds.slice(0, processed))
    await claim.release(organizationIds.slice(processed))
  }

  return { organizations: total, processed, deferred: total - processed }
}

/** Builds a Prisma `organizationId` filter from tick options. */
export function organizationFilter(options?: TickOptions) {
  return options?.organizationIds ? { organizationId: { in: [...options.organizationIds] } } : {}
}

/** Builds a raw SQL `AND <column> IN (...)` restriction from tick options. */
export function organizationSqlFilter(column: Prisma.Sql, options?: TickOptions) {
  return options?.organizationIds
    ? options.organizationIds.length === 0
      ? Prisma.sql`AND FALSE`
      : Prisma.sql`AND ${column} IN (${Prisma.join([...options.organizationIds])})`
    : Prisma.empty
}
