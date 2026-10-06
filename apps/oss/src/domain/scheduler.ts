import { Prisma } from "../../generated/prisma/client"
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
 * The organizations a task may work on, ordered by id. `count` and `page` must use the same
 * predicate, so a page is a slice of one consistent ordering.
 */
export type OrganizationSource = {
  count: () => Promise<number>
  page: (offset: number, limit: number) => Promise<string[]>
}

/** Length of one rotation slot. Cron cadences are whole minutes. */
const ROTATION_SLOT_MS = 60_000
/** Smallest rotation cycle; a prime above 7 so no common cadence aliases with it. */
const MIN_ROTATION_CYCLE = 11
/** 2^64 / golden ratio: spreads consecutive slots evenly over a page (Fibonacci hashing). */
const GOLDEN_64 = 0x9e3779b97f4a7c15n
const MASK_64 = (1n << 64n) - 1n

function isPrime(value: number) {
  if (value < 2) return false
  for (let divisor = 2; divisor * divisor <= value; divisor += 1) {
    if (value % divisor === 0) return false
  }
  return true
}

function nextPrimeAtLeast(value: number) {
  let candidate = Math.max(value, 2)
  while (!isPrime(candidate)) candidate += 1
  return candidate
}

/**
 * Chooses, from the tick time alone, which page of `total` eligible organizations a tick works
 * on and where inside the page it starts. No state is kept, so a restarted process or a second
 * worker continues the same rotation instead of starting at the first organization.
 *
 * Time is cut into one-minute slots, and the slots cycle through `cycle` positions, where `cycle`
 * is a prime of at least 11 and at least the page count. Positions past the last page fold back
 * onto the pages. Ticks every T minutes visit every position, and so every page, within `cycle`
 * ticks whenever T is not a multiple of `cycle`; that holds for every cadence built from 2, 3, 5
 * and 7 (every minute, 5 or 15 minutes, hourly, daily, weekly). Ticks closer together than a
 * slot repeat the same page, which is harmless because every task is idempotent.
 *
 * The start inside the page also moves with the slot, so when the time budget stops a tick
 * before the end of its page, a different organization goes first the next time round.
 */
export function rotationWindow(now: Date, total: number, pageSize: number) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const slot = Math.floor(now.getTime() / ROTATION_SLOT_MS)
  const cycle = pages === 1 ? 1 : nextPrimeAtLeast(Math.max(pages, MIN_ROTATION_CYCLE))
  const page = (slot % cycle) % pages
  const pageLength = Math.min(pageSize, total - page * pageSize)
  const spread = (BigInt(slot) * GOLDEN_64) & MASK_64
  const start = pageLength > 0 ? Number((spread * BigInt(pageLength)) >> 64n) : 0
  return { page, pages, cycle, offset: page * pageSize, pageLength, start }
}

/**
 * Runs `work` for one page of eligible organizations until the task's per-tick budget is used
 * up. The page and the first organization come from `rotationWindow`, so every organization is
 * reached within a bounded number of ticks however many there are, across restarts and workers.
 * Combined with a bounded amount of work per organization, a tick finishes in bounded time
 * however large the backlog is.
 */
export async function forEachOrganizationWithinBudget(
  now: Date,
  source: OrganizationSource,
  work: (organizationId: string) => Promise<void>,
  budget: OrganizationBudget = DEFAULT_ORGANIZATION_BUDGET
) {
  const total = await source.count()
  if (total === 0) {
    return { organizations: 0, processed: 0, deferred: 0 }
  }

  const window = rotationWindow(now, total, budget.maxOrganizations)
  const organizationIds = await source.page(window.offset, budget.maxOrganizations)
  const startedAt = Date.now()
  let processed = 0
  while (
    processed < organizationIds.length &&
    (processed === 0 || Date.now() - startedAt < budget.timeBudgetMs)
  ) {
    await work(organizationIds[(window.start + processed) % organizationIds.length]!)
    processed += 1
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
