import { appLogger } from "../../lib/observability"
import { Prisma } from "../../../generated/prisma/client"
import {
  REMINDABLE_STATUSES,
  REMINDER_SEND_JOB,
  deliverScheduledReminder,
  scheduleDueReminders,
  schedulerActor,
} from "../commands/reminders"
import { executeCommand } from "../execute"
import { registerJobHandler } from "../jobs"
import {
  DEFAULT_ORGANIZATION_BUDGET,
  forEachOrganizationWithinBudget,
  organizationSqlFilter,
  registerTickTask,
  scannedOrganizationSource,
  type OrganizationBudget,
  type OrganizationSource,
  type TickOptions,
} from "../scheduler"

const remindersLogger = appLogger.child("reminders")

/**
 * Organizations with reminders turned on and at least one open, unpaused invoice with a balance
 * due and a recipient (the settlement predicate `scheduleDueReminders` uses). Claimed in the
 * database, least recently scanned first.
 */
export function reminderOrganizations(options?: TickOptions): OrganizationSource {
  return scannedOrganizationSource(
    "reminders",
    Prisma.sql`
      SELECT i."organizationId" FROM "invoice" i
      JOIN "org_settings" s ON s."organizationId" = i."organizationId"
      JOIN "contact" c ON c."id" = i."contactId"
      WHERE s."reminderPolicy"->>'enabled' = 'true'
        AND i."status" IN (${Prisma.join([...REMINDABLE_STATUSES])})
        AND i."remindersPaused" = false
        AND i."totalGross" - i."amountCredited" - i."amountPaid" > 0
        AND NULLIF(TRIM(c."email"), '') IS NOT NULL
        ${organizationSqlFilter(Prisma.sql`i."organizationId"`, options)}
    `
  )
}

/**
 * Reserves due reminders for organizations with reminders enabled: one bounded batch per
 * organization per tick, within the tick's organization budget. Reserved reminders are queued as
 * jobs that the tick's `jobs` task sends; anything not reached is picked up by the next tick.
 */
export async function runReminderTask(
  now: Date = new Date(),
  options?: TickOptions,
  budget: OrganizationBudget = DEFAULT_ORGANIZATION_BUDGET
) {
  let scheduled = 0
  let skipped = 0
  let failed = 0
  let remaining = 0
  const { organizations, deferred } = await forEachOrganizationWithinBudget(
    reminderOrganizations(options),
    async (organizationId) => {
      try {
        const outcome = await executeCommand(scheduleDueReminders, {}, {
          actor: schedulerActor(organizationId),
          now,
        })
        if (outcome.status === "completed") {
          scheduled += outcome.result.scheduled
          skipped += outcome.result.skipped
          if (outcome.result.more) remaining += 1
        } else {
          failed += 1
        }
      } catch (error) {
        failed += 1
        remindersLogger.error("reminders.organization_failed", { organizationId, error })
      }
    },
    budget
  )

  return { organizations, scheduled, skipped, failed, remaining: remaining + deferred }
}

/**
 * Sends one reserved reminder. Throwing lets the job runner retry with backoff; the command's
 * idempotency key and the reminder's final outcome keep retries from sending twice.
 */
export async function handleReminderSendJob(job: { organizationId: string; payload: unknown }) {
  const payload = job.payload as { reminderId?: unknown; attempt?: unknown } | null
  const reminderId = typeof payload?.reminderId === "string" ? payload.reminderId : null
  // A reminder re-queued after its email was withdrawn runs again under a new request id.
  const attempt = typeof payload?.attempt === "string" ? `:${payload.attempt}` : ""
  if (!reminderId) {
    throw new Error("reminder.send job is missing reminderId")
  }

  const outcome = await executeCommand(
    deliverScheduledReminder,
    { reminderId },
    { actor: schedulerActor(job.organizationId), clientRequestId: `reminder.send:${reminderId}${attempt}` }
  )
  if (outcome.status !== "completed") {
    throw new Error(
      outcome.status === "awaiting_approval" ? "Reminder unexpectedly awaits approval" : outcome.error.message
    )
  }
}

registerJobHandler(REMINDER_SEND_JOB, handleReminderSendJob)
registerTickTask({ name: "reminders", order: 20, run: runReminderTask })
