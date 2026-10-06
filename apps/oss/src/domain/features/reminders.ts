import { prisma } from "../../lib/db"
import { appLogger } from "../../lib/observability"
import {
  REMINDER_SEND_JOB,
  deliverScheduledReminder,
  scheduleDueReminders,
  schedulerActor,
} from "../commands/reminders"
import { executeCommand } from "../execute"
import { registerJobHandler } from "../jobs"
import { registerTickTask } from "../scheduler"

const remindersLogger = appLogger.child("reminders")

/** Reserves and dispatches due reminders for every organization with reminders enabled. */
export async function runReminderTask(now: Date = new Date()) {
  const organizations = await prisma.orgSettings.findMany({
    where: { reminderPolicy: { path: ["enabled"], equals: true } },
    select: { organizationId: true },
  })

  let scheduled = 0
  let skipped = 0
  let failed = 0
  for (const { organizationId } of organizations) {
    try {
      const outcome = await executeCommand(scheduleDueReminders, {}, {
        actor: schedulerActor(organizationId),
        now,
      })
      if (outcome.status === "completed") {
        scheduled += outcome.result.scheduled
        skipped += outcome.result.skipped
      } else {
        failed += 1
      }
    } catch (error) {
      failed += 1
      remindersLogger.error("reminders.organization_failed", { organizationId, error })
    }
  }

  return { organizations: organizations.length, scheduled, skipped, failed }
}

/**
 * Sends one reserved reminder. Throwing lets the job runner retry with backoff; the command's
 * idempotency key and the reminder's final outcome keep retries from sending twice.
 */
export async function handleReminderSendJob(job: { organizationId: string; payload: unknown }) {
  const payload = job.payload as { reminderId?: unknown } | null
  const reminderId = typeof payload?.reminderId === "string" ? payload.reminderId : null
  if (!reminderId) {
    throw new Error("reminder.send job is missing reminderId")
  }

  const outcome = await executeCommand(
    deliverScheduledReminder,
    { reminderId },
    { actor: schedulerActor(job.organizationId), clientRequestId: `reminder.send:${reminderId}` }
  )
  if (outcome.status !== "completed") {
    throw new Error(
      outcome.status === "awaiting_approval" ? "Reminder unexpectedly awaits approval" : outcome.error.message
    )
  }
}

registerJobHandler(REMINDER_SEND_JOB, handleReminderSendJob)
registerTickTask({ name: "reminders", order: 20, run: runReminderTask })
