import { prisma } from "../../lib/db"
import { appLogger } from "../../lib/observability"
import {
  generateRecurringRun,
  recordRecurringRunFailure,
  recurringSystemActor,
  runRequestId,
} from "../commands/recurring"
import { executeCommand } from "../execute"
import { registerTickTask } from "../scheduler"

const recurringLogger = appLogger.child("recurring")

/** How many missed runs of one schedule a single tick catches up on. */
export const MAX_RUNS_PER_SCHEDULE_PER_TICK = 12
const MAX_SCHEDULES_PER_TICK = 200

/** Generates the due runs of one schedule in order, up to the per-tick limit. */
async function processSchedule(id: string, organizationId: string, now: Date) {
  const actor = recurringSystemActor(organizationId)
  let generated = 0
  let previousRunDate: Date | null = null

  for (let run = 0; run < MAX_RUNS_PER_SCHEDULE_PER_TICK; run += 1) {
    const schedule = await prisma.recurringInvoice.findUnique({
      where: { id },
      select: { status: true, nextRunAt: true },
    })
    if (!schedule || schedule.status !== "active" || schedule.nextRunAt > now) {
      break
    }
    // A replayed receipt does not advance the schedule; never spin on the same run.
    if (previousRunDate?.getTime() === schedule.nextRunAt.getTime()) {
      break
    }

    const runDate = schedule.nextRunAt
    previousRunDate = runDate
    const outcome = await executeCommand(
      generateRecurringRun,
      { id, runDate: runDate.toISOString() },
      { actor, clientRequestId: runRequestId(id, runDate), now }
    )

    if (outcome.status === "completed") {
      if (outcome.result.invoice) {
        generated += 1
      }
      continue
    }
    if (outcome.status === "awaiting_approval") {
      break
    }
    // Another tick handled this run, or a provider outage that the next tick retries.
    if (outcome.error.code === "run_not_due" || outcome.error.tag === "ExternalFailure") {
      break
    }

    recurringLogger.warn("recurring.run_failed", {
      organizationId,
      recurringInvoiceId: id,
      runDate: runDate.toISOString(),
      error: outcome.error,
    })
    await executeCommand(
      recordRecurringRunFailure,
      { id, runDate: runDate.toISOString(), error: outcome.error },
      { actor, now }
    )
    return { generated, failed: 1 }
  }

  return { generated, failed: 0 }
}

/**
 * Generates the invoices of every active schedule whose next run is due, oldest first.
 *
 * Each run executes as the recurring system actor with the idempotency key
 * `recurring:<scheduleId>:<runDate>`, and the generated invoice carries the unique
 * `(recurringInvoiceId, recurringRunDate)` pair, so overlapping or retried ticks never create a
 * second invoice for the same run. A run that cannot be generated pauses its schedule and
 * records why (`recurring.run_failed`).
 */
export async function runRecurringTick(now: Date) {
  const due = await prisma.recurringInvoice.findMany({
    where: { status: "active", nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
    take: MAX_SCHEDULES_PER_TICK,
    select: { id: true, organizationId: true },
  })

  let generated = 0
  let failed = 0

  for (const { id, organizationId } of due) {
    try {
      const result = await processSchedule(id, organizationId, now)
      generated += result.generated
      failed += result.failed
    } catch (error) {
      // One broken schedule must not stop the others; the next tick retries it.
      failed += 1
      recurringLogger.error("recurring.schedule_crashed", { organizationId, recurringInvoiceId: id, error })
    }
  }

  return { due: due.length, generated, failed }
}

registerTickTask({ name: "recurring", order: 30, run: runRecurringTick })
