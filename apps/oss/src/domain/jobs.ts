import type { Prisma } from "../../generated/prisma/client"
import { prisma } from "../lib/db"
import { appLogger } from "../lib/observability"

const MAX_ATTEMPTS = 5
/**
 * A job still `running` after this long was claimed by a process that stopped. Longer than any
 * command transaction (60s), so a live runner is never interrupted.
 */
const RUNNING_LEASE_MS = 15 * 60 * 1000
const jobsLogger = appLogger.child("jobs")

/**
 * A job handler. Returning means the job is done. Throwing `TerminalJobError` means it failed for
 * good (retrying cannot help, e.g. a missing recipient or a document that fails validation): the
 * job is failed at once, without retries. Throwing anything else is treated as transient and the
 * job is retried with backoff until its attempts run out.
 */
export type JobHandler = (job: {
  id: string
  organizationId: string
  payload: Prisma.JsonValue
  attempts: number
}) => Promise<void>

/** Thrown by a job handler for a failure that retrying cannot fix. */
export class TerminalJobError extends Error {
  override readonly name = "TerminalJobError"
}

const handlers = new Map<string, JobHandler>()

export function registerJobHandler(type: string, handler: JobHandler) {
  handlers.set(type, handler)
}

function backoffMs(attempts: number) {
  return Math.min(2 ** attempts, 60) * 60_000
}

/**
 * What happened to one job run: not claimed (another runner has it), done, failed and queued for a
 * retry, failed after its last attempt, or failed permanently (`TerminalJobError`).
 */
export type JobRunOutcome = "skipped" | "done" | "retrying" | "exhausted" | "terminal"

async function runJob(id: string, now: Date): Promise<JobRunOutcome> {
  // Claim atomically so concurrent runners never execute the same job twice.
  const claimed = await prisma.job.updateMany({
    where: { id, status: "pending", runAfter: { lte: now } },
    data: { status: "running", attempts: { increment: 1 } },
  })
  if (claimed.count === 0) {
    return "skipped"
  }

  const job = await prisma.job.findUniqueOrThrow({ where: { id } })
  const handler = handlers.get(job.type)

  try {
    if (!handler) {
      throw new Error(`No handler registered for job type ${job.type}`)
    }
    await handler(job)
    await prisma.job.update({ where: { id }, data: { status: "done", lastError: null } })
    return "done"
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const terminal = error instanceof TerminalJobError
    const exhausted = job.attempts >= MAX_ATTEMPTS
    const failed = terminal || exhausted
    await prisma.job.update({
      where: { id },
      data: failed
        ? { status: "failed", lastError: message.slice(0, 1000) }
        : {
            status: "pending",
            lastError: message.slice(0, 1000),
            runAfter: new Date(now.getTime() + backoffMs(job.attempts)),
          },
    })
    jobsLogger.warn("job.failed", { jobId: id, type: job.type, attempts: job.attempts, terminal, exhausted, error })
    return terminal ? "terminal" : exhausted ? "exhausted" : "retrying"
  }
}

/**
 * Counts of one batch of job runs. `retrying` failed and will run again after a backoff;
 * `failed` failed permanently or used up their attempts and need a person; `deferred` were not started because the
 * batch ran out of time and stay queued for the next sweep.
 */
export type JobBatchResult = {
  processed: number
  succeeded: number
  retrying: number
  failed: number
  deferred: number
}

/** Runs jobs in order. With a deadline, no new job starts after it (the first always runs). */
async function runJobBatch(ids: readonly string[], now: Date, deadline?: number): Promise<JobBatchResult> {
  const result: JobBatchResult = { processed: 0, succeeded: 0, retrying: 0, failed: 0, deferred: 0 }
  for (const [index, id] of ids.entries()) {
    if (deadline !== undefined && index > 0 && Date.now() >= deadline) {
      result.deferred = ids.length - index
      break
    }
    const outcome = await runJob(id, now)
    if (outcome === "skipped") continue
    result.processed += 1
    if (outcome === "done") result.succeeded += 1
    else if (outcome === "retrying") result.retrying += 1
    else result.failed += 1
  }
  return result
}

/** Runs specific jobs right after the transaction that created them commits. */
export async function runJobsNow(ids: string[], now = new Date()) {
  return runJobBatch(ids, now)
}

export type JobScope = {
  /** Only these organizations' jobs; tests pass their own so they never touch shared data. */
  organizationIds?: readonly string[]
}

function scopeFilter(scope?: JobScope) {
  return scope?.organizationIds ? { organizationId: { in: [...scope.organizationIds] } } : {}
}

/**
 * Returns abandoned `running` jobs to the queue, or fails them once attempts are exhausted.
 * `failed` counts jobs that ran out of attempts this way.
 */
export async function reclaimStaleJobs(now = new Date(), scope?: JobScope) {
  const staleBefore = new Date(now.getTime() - RUNNING_LEASE_MS)
  const stale = { ...scopeFilter(scope), status: "running", updatedAt: { lt: staleBefore } }
  const [requeued, exhausted] = await prisma.$transaction([
    prisma.job.updateMany({
      where: { ...stale, attempts: { lt: MAX_ATTEMPTS } },
      data: { status: "pending", runAfter: now, lastError: "Runner stopped before finishing" },
    }),
    prisma.job.updateMany({
      where: { ...stale, attempts: { gte: MAX_ATTEMPTS } },
      data: { status: "failed", lastError: "Runner stopped before finishing" },
    }),
  ])
  if (requeued.count + exhausted.count > 0) {
    jobsLogger.warn("job.reclaimed", { requeued: requeued.count, failed: exhausted.count })
  }
  return { requeued: requeued.count, failed: exhausted.count }
}

/** Jobs one sweep starts at most; the rest run on the next sweep. */
export const DEFAULT_JOBS_PER_SWEEP = 100
/** A sweep starts no new job after this long, so the deliveries it makes stay bounded in time. */
export const DEFAULT_JOBS_TIME_BUDGET_MS = 45_000

/**
 * Sweeps due jobs, oldest first; called by the scheduler tick. Bounded by `limit` jobs and by
 * `timeBudgetMs`: once the budget is used no new job is claimed, and the rest stay queued.
 * `failed` includes jobs that ran out of attempts, whether they failed here or were abandoned by
 * a runner that stopped.
 */
export async function runDueJobs(
  input: { now?: Date; limit?: number; timeBudgetMs?: number } & JobScope = {}
) {
  const now = input.now ?? new Date()
  const deadline = Date.now() + (input.timeBudgetMs ?? DEFAULT_JOBS_TIME_BUDGET_MS)
  const reclaimed = await reclaimStaleJobs(now, input)
  const due = await prisma.job.findMany({
    where: { ...scopeFilter(input), status: "pending", runAfter: { lte: now } },
    orderBy: { runAfter: "asc" },
    take: input.limit ?? DEFAULT_JOBS_PER_SWEEP,
    select: { id: true },
  })

  const batch = await runJobBatch(
    due.map((job) => job.id),
    now,
    deadline
  )
  return {
    ...batch,
    failed: batch.failed + reclaimed.failed,
    reclaimed: reclaimed.requeued + reclaimed.failed,
  }
}
