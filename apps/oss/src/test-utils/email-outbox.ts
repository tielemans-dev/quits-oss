import { EMAIL_DELIVERY_JOB } from "../domain/delivery/outbox"
import { runJobsNow } from "../domain/jobs"
import { prisma } from "../lib/db"

/** Email delivery jobs of one organization, oldest first. */
export function findEmailDeliveryJobs(organizationId: string) {
  return prisma.job.findMany({
    where: { organizationId, type: EMAIL_DELIVERY_JOB },
    orderBy: { createdAt: "asc" },
  })
}

/**
 * Runs the organization's pending email deliveries now, as the job sweep would once their retry
 * backoff has passed. Only email deliveries run, so other queued work is left alone.
 */
export async function retryEmailDeliveries(organizationId: string) {
  const pending = await prisma.job.findMany({
    where: { organizationId, type: EMAIL_DELIVERY_JOB, status: "pending" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  })
  const ids = pending.map((job) => job.id)
  const now = new Date()
  await prisma.job.updateMany({ where: { id: { in: ids } }, data: { runAfter: now } })
  return runJobsNow(ids, now)
}
