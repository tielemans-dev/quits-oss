import { prisma } from "../lib/db"
import { appLogger } from "../lib/observability"
import { runDueJobs, runJobsNow } from "./jobs"

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
const JOBS_PER_TICK = 100

/** Runs due jobs of specific organizations, oldest first. */
export async function runOrganizationJobs(
  organizationIds: readonly string[],
  now: Date = new Date(),
  limit = JOBS_PER_TICK
) {
  const due = await prisma.job.findMany({
    where: { organizationId: { in: [...organizationIds] }, status: "pending", runAfter: { lte: now } },
    orderBy: { runAfter: "asc" },
    take: limit,
    select: { id: true },
  })
  await runJobsNow(
    due.map((job) => job.id),
    now
  )
  return { processed: due.length }
}

const tasks: TickTask[] = [
  {
    name: "jobs",
    order: 1000,
    run: async (now, options) =>
      options?.organizationIds
        ? runOrganizationJobs(options.organizationIds, now)
        : runDueJobs({ now, limit: JOBS_PER_TICK }),
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

/** Where each task continues next tick, so organizations late in the list are not starved. */
const rotation = new Map<string, number>()

/**
 * Runs `work` for organizations until the task's per-tick budget is used up. Each tick starts
 * where the previous one stopped; organizations not reached are picked up next tick. Combined
 * with a bounded amount of work per organization, a tick finishes in bounded time however
 * large the backlog is.
 */
export async function forEachOrganizationWithinBudget(
  task: string,
  organizationIds: readonly string[],
  work: (organizationId: string) => Promise<void>,
  budget: OrganizationBudget = DEFAULT_ORGANIZATION_BUDGET
) {
  const total = organizationIds.length
  if (total === 0) {
    return { processed: 0, deferred: 0 }
  }

  const start = (rotation.get(task) ?? 0) % total
  const startedAt = Date.now()
  let processed = 0
  while (
    processed < total &&
    processed < budget.maxOrganizations &&
    (processed === 0 || Date.now() - startedAt < budget.timeBudgetMs)
  ) {
    await work(organizationIds[(start + processed) % total]!)
    processed += 1
  }

  rotation.set(task, (start + processed) % total)
  return { processed, deferred: total - processed }
}

/** Builds a Prisma `organizationId` filter from tick options. */
export function organizationFilter(options?: TickOptions) {
  return options?.organizationIds ? { organizationId: { in: [...options.organizationIds] } } : {}
}
