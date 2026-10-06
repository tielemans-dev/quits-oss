import type { Prisma } from "../../generated/prisma/client"
import { prisma } from "../lib/db"
import { appLogger } from "../lib/observability"

const MAX_ATTEMPTS = 5
const jobsLogger = appLogger.child("jobs")

export type JobHandler = (job: {
  id: string
  organizationId: string
  payload: Prisma.JsonValue
  attempts: number
}) => Promise<void>

const handlers = new Map<string, JobHandler>()

export function registerJobHandler(type: string, handler: JobHandler) {
  handlers.set(type, handler)
}

function backoffMs(attempts: number) {
  return Math.min(2 ** attempts, 60) * 60_000
}

async function runJob(id: string, now: Date) {
  // Claim atomically so concurrent runners never execute the same job twice.
  const claimed = await prisma.job.updateMany({
    where: { id, status: "pending", runAfter: { lte: now } },
    data: { status: "running", attempts: { increment: 1 } },
  })
  if (claimed.count === 0) {
    return
  }

  const job = await prisma.job.findUniqueOrThrow({ where: { id } })
  const handler = handlers.get(job.type)

  try {
    if (!handler) {
      throw new Error(`No handler registered for job type ${job.type}`)
    }
    await handler(job)
    await prisma.job.update({ where: { id }, data: { status: "done", lastError: null } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const exhausted = job.attempts >= MAX_ATTEMPTS
    await prisma.job.update({
      where: { id },
      data: {
        status: exhausted ? "failed" : "pending",
        lastError: message.slice(0, 1000),
        runAfter: new Date(now.getTime() + backoffMs(job.attempts)),
      },
    })
    jobsLogger.warn("job.failed", { jobId: id, type: job.type, attempts: job.attempts, exhausted, error })
  }
}

/** Runs specific jobs right after the transaction that created them commits. */
export async function runJobsNow(ids: string[], now = new Date()) {
  for (const id of ids) {
    await runJob(id, now)
  }
}

/** Sweeps due jobs; called by the scheduler tick. */
export async function runDueJobs(input: { now?: Date; limit?: number } = {}) {
  const now = input.now ?? new Date()
  const due = await prisma.job.findMany({
    where: { status: "pending", runAfter: { lte: now } },
    orderBy: { runAfter: "asc" },
    take: input.limit ?? 50,
    select: { id: true },
  })

  await runJobsNow(
    due.map((job) => job.id),
    now
  )
  return { processed: due.length }
}
