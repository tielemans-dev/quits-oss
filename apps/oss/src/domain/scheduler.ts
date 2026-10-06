import { Prisma } from "../../generated/prisma/client"
import { prisma } from "../lib/db"
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
  /** A task starts no new organization after this long. */
  timeBudgetMs: number
}

export const DEFAULT_ORGANIZATION_BUDGET: OrganizationBudget = {
  maxOrganizations: 200,
  timeBudgetMs: 45_000,
}

/**
 * The organizations a task may work on. `claim` hands out the least recently scanned eligible
 * organizations and records that they were scanned, so successive ticks work through every
 * eligible organization whatever their cadence or the time they pass. `release` gives back claimed
 * organizations a tick did not reach, so they go first next time.
 */
export type OrganizationSource = {
  count: () => Promise<number>
  claim: (limit: number) => Promise<string[]>
  release: (organizationIds: readonly string[]) => Promise<void>
}

/**
 * An organization source backed by `scheduler_scan`, which keeps when `task` last claimed each
 * organization. `eligible` is a query returning an `"organizationId"` column (repeats allowed).
 *
 * Claims order by the last scan, never-scanned first, so the rotation is durable across restarts
 * and independent of the tick cadence or clock. Concurrent ticks lock the rows they claim and skip
 * rows another tick holds (`FOR UPDATE SKIP LOCKED`), so they work on different organizations.
 * Scan times come from the database clock, never from the tick's `now`.
 */
export function scannedOrganizationSource(task: string, eligible: Prisma.Sql): OrganizationSource {
  return {
    count: async () => {
      const [row] = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT e."organizationId") AS "count" FROM (${eligible}) e
      `
      return Number(row?.count ?? 0)
    },
    claim: async (limit) => {
      // Organizations that became eligible since the last tick start out never scanned.
      await prisma.$executeRaw`
        INSERT INTO "scheduler_scan" ("task", "organizationId")
        SELECT DISTINCT ${task}, e."organizationId" FROM (${eligible}) e
        ON CONFLICT ("task", "organizationId") DO NOTHING
      `
      const rows = await prisma.$queryRaw<Array<{ organizationId: string; previousScannedAt: Date | null }>>`
        WITH candidates AS (
          SELECT s."organizationId", s."scannedAt"
          FROM "scheduler_scan" s
          WHERE s."task" = ${task}
            AND s."organizationId" IN (SELECT e."organizationId" FROM (${eligible}) e)
          ORDER BY s."scannedAt" ASC NULLS FIRST, s."organizationId" ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "scheduler_scan" s
        SET "scannedAt" = clock_timestamp()
        FROM candidates c
        WHERE s."task" = ${task} AND s."organizationId" = c."organizationId"
        RETURNING s."organizationId", c."scannedAt" AS "previousScannedAt"
      `
      // RETURNING has no order; work oldest first so a time budget cuts the most recently scanned.
      return rows
        .sort(
          (a, b) =>
            (a.previousScannedAt?.getTime() ?? -Infinity) - (b.previousScannedAt?.getTime() ?? -Infinity) ||
            a.organizationId.localeCompare(b.organizationId)
        )
        .map((row) => row.organizationId)
    },
    release: async (organizationIds) => {
      if (organizationIds.length === 0) return
      await prisma.$executeRaw`
        UPDATE "scheduler_scan" SET "scannedAt" = NULL
        WHERE "task" = ${task} AND "organizationId" IN (${Prisma.join([...organizationIds])})
      `
    },
  }
}

/**
 * Runs `work` for the organizations `source` claims, least recently scanned first, until the
 * task's per-tick budget is used up. Claimed organizations the time budget left unreached are
 * released and go first next tick. Every eligible organization is reached within
 * ceil(eligible / maxOrganizations) ticks of a full budget, and combined with a bounded amount of
 * work per organization, a tick finishes in bounded time however large the backlog is.
 */
export async function forEachOrganizationWithinBudget(
  source: OrganizationSource,
  work: (organizationId: string) => Promise<void>,
  budget: OrganizationBudget = DEFAULT_ORGANIZATION_BUDGET
) {
  const total = await source.count()
  if (total === 0) {
    return { organizations: 0, processed: 0, deferred: 0 }
  }

  const organizationIds = await source.claim(budget.maxOrganizations)
  const startedAt = Date.now()
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
    if (processed < organizationIds.length) {
      await source.release(organizationIds.slice(processed))
    }
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
