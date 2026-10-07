import { Effect } from "effect"
import { z } from "zod"
import { commandErrorSchema } from "@quits/contracts/agent"
import {
  recurringCreateInputSchema,
  recurringIdInputSchema,
  recurringItemsSchema,
  recurringSetStatusInputSchema,
  recurringUpdateInputSchema,
  type RecurringEnd,
} from "@quits/contracts/recurring"
import type { Prisma } from "../../../generated/prisma/client"
import { createEmailDeliveryAttempt } from "../../lib/email-delivery"
import { actorKey, type SystemActor } from "../actor"
import { defineCommand, type AnyCommandDefinition } from "../command"
import { lockDocument } from "../documents/locks"
import { Forbidden, InvalidState, NotFound, ValidationFailed } from "../errors"
import { executeCommand } from "../execute"
import { registerJobHandler, TerminalJobError } from "../jobs"
import { Command, Db, type CommandScope } from "../services"
import {
  addUtcDays,
  advanceRunDate,
  anchorDayOf,
  firstRunDateFrom,
  formatCalendarDate,
  parseCalendarDate,
  type IntervalUnit,
} from "../features/recurring-dates"
import { buildInvoiceDraft, sendInvoice } from "./invoices"
import { recurringApproval } from "../approval-contexts"

/*
 * Agent approval rule
 * -------------------
 * A schedule becomes outward-facing only when it is active and auto-sends: from then on it
 * emails customers without anyone looking. So:
 *
 * - `recurring.create` and `recurring.update` are not outward-facing. When an agent in
 *   `approval_required` mode creates or edits a schedule that would be active and auto-sending,
 *   the schedule is saved paused instead. Edits by such an agent to an active auto-sending
 *   schedule pause it too, so an agent cannot change what is being sent without review.
 * - `recurring.resume` (turning a schedule on) is outward-facing, so the agent's activation is
 *   queued in the approval inbox. Pausing and ending (`recurring.set_status`) are not, so an
 *   agent can always stop a schedule.
 * - `recurring.run_now` is outward-facing because it sends the generated invoice when the
 *   schedule auto-sends.
 */
function requiresHumanActivation(scope: CommandScope) {
  return (
    scope.actor.kind === "agent" &&
    scope.actor.mode === "approval_required" &&
    !scope.approvedByUserId
  )
}

export const AUTO_SEND_JOB = "recurring.auto_send"

export function recurringSystemActor(organizationId: string): SystemActor {
  return { kind: "system", organizationId, reason: "recurring", label: "Recurring invoices" }
}

/** Idempotency key for generating one run of a schedule. */
export function runRequestId(recurringInvoiceId: string, runDate: Date) {
  return `recurring:${recurringInvoiceId}:${runDate.toISOString()}`
}

type ScheduleRow = Prisma.RecurringInvoiceGetPayload<object>

function cadenceOf(schedule: Pick<ScheduleRow, "startDate" | "intervalCount" | "intervalUnit">) {
  return {
    startDate: schedule.startDate,
    intervalCount: schedule.intervalCount,
    intervalUnit: schedule.intervalUnit as IntervalUnit,
  }
}

function endFields(end: RecurringEnd) {
  switch (end.type) {
    case "none":
      return { endsAt: null, remainingRuns: null }
    case "on_date":
      return { endsAt: parseCalendarDate(end.endsAt), remainingRuns: null }
    case "after_runs":
      return { endsAt: null, remainingRuns: end.runs }
  }
}

const findSchedule = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    const schedule = yield* Effect.promise(() =>
      db.recurringInvoice.findFirst({ where: { id, organizationId } })
    )
    if (!schedule) {
      return yield* new NotFound({ message: "Recurring schedule not found", entity: "recurringInvoice", id })
    }
    return schedule
  })

/**
 * Locks the schedule row for the rest of the command, then reads it. Every command that changes
 * a schedule goes through here, so an edit and a concurrent run (which advances `nextRunAt`,
 * `remainingRuns`, and `status`) run one after the other and neither writes back stale values.
 */
const findScheduleForUpdate = (id: string) =>
  Effect.gen(function* () {
    yield* lockDocument("recurringInvoice", id)
    return yield* findSchedule(id)
  })

const assertContact = (contactId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    const contact = yield* Effect.promise(() =>
      db.contact.findFirst({ where: { id: contactId, organizationId }, select: { id: true } })
    )
    if (!contact) {
      return yield* new InvalidState({
        message: "Invalid contact for this organization",
        code: "invalid_contact",
      })
    }
  })

function assertEndAfterNextRun(endsAt: Date | null, nextRunAt: Date) {
  return endsAt && nextRunAt > endsAt
    ? Effect.fail(
        new ValidationFailed({
          message: "The end date is before the next run date",
          issues: [{ path: "end.endsAt", message: "Must be on or after the next run date" }],
        })
      )
    : Effect.void
}

/**
 * Failed run attempts are cached under their idempotency key. When a person changes the
 * schedule or resumes it, those attempts may succeed now, so their receipts are cleared.
 */
const clearFailedRunAttempts = (recurringInvoiceId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    yield* Effect.promise(() =>
      db.commandReceipt.deleteMany({
        where: {
          organizationId,
          actorKey: actorKey(recurringSystemActor(organizationId)),
          clientRequestId: { startsWith: `recurring:${recurringInvoiceId}:` },
          status: "failed",
        },
      })
    )
  })

function emitStatusChange(
  command: CommandScope,
  scheduleId: string,
  from: string,
  to: string,
  reason: string
) {
  if (from === to) return
  command.emit({
    aggregateType: "recurring",
    aggregateId: scheduleId,
    type: "recurring.status_changed",
    payload: { from, to, reason },
  })
}

export const createRecurringInvoice = defineCommand({
  type: "recurring.create",
  permission: "recurring:create",
  outwardFacing: false,
  input: recurringCreateInputSchema,
  summarize: (input) => `Create recurring schedule "${input.name}"`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { organizationId, now } = command

      yield* assertContact(input.contactId)
      const settings = yield* Effect.promise(() =>
        db.orgSettings.findUnique({
          where: { organizationId },
          select: { currency: true, defaultCurrency: true },
        })
      )

      const startDate = parseCalendarDate(input.startDate)
      // A start date in the past only sets the anchor; missed periods are not back-billed.
      const nextRunAt = firstRunDateFrom(
        { startDate, intervalCount: input.intervalCount, intervalUnit: input.intervalUnit },
        now
      )
      const end = endFields(input.end)
      yield* assertEndAfterNextRun(end.endsAt, nextRunAt)

      const status = input.autoSend && requiresHumanActivation(command) ? "paused" : "active"
      const schedule = yield* Effect.promise(() =>
        db.recurringInvoice.create({
          data: {
            organizationId,
            contactId: input.contactId,
            name: input.name,
            status,
            intervalCount: input.intervalCount,
            intervalUnit: input.intervalUnit,
            startDate,
            nextRunAt,
            ...end,
            dueInDays: input.dueInDays,
            autoSend: input.autoSend,
            currency: input.currency ?? settings?.defaultCurrency ?? settings?.currency ?? "USD",
            taxRate: input.taxRate,
            notes: input.notes ?? null,
            items: input.items,
          },
        })
      )

      command.emit({
        aggregateType: "recurring",
        aggregateId: schedule.id,
        type: "recurring.created",
        payload: {
          name: schedule.name,
          contactId: schedule.contactId,
          status,
          autoSend: schedule.autoSend,
          nextRunAt: schedule.nextRunAt.toISOString(),
        },
      })
      return schedule
    }),
})

export const updateRecurringInvoice = defineCommand({
  type: "recurring.update",
  permission: "recurring:update",
  outwardFacing: false,
  input: recurringUpdateInputSchema,
  summarize: (input) => `Update recurring schedule ${input.id}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const existing = yield* findScheduleForUpdate(input.id)

      if (existing.status === "ended") {
        return yield* new InvalidState({
          message: "Ended schedules cannot be edited",
          code: "schedule_ended",
        })
      }
      if (input.contactId) {
        yield* assertContact(input.contactId)
      }

      const cadence = {
        startDate: input.startDate ? parseCalendarDate(input.startDate) : existing.startDate,
        intervalCount: input.intervalCount ?? existing.intervalCount,
        intervalUnit: input.intervalUnit ?? (existing.intervalUnit as IntervalUnit),
      }
      const cadenceChanged =
        cadence.startDate.getTime() !== existing.startDate.getTime() ||
        cadence.intervalCount !== existing.intervalCount ||
        cadence.intervalUnit !== existing.intervalUnit
      const nextRunAt = cadenceChanged
        ? firstRunDateFrom(cadence, command.now, existing.lastRunAt)
        : existing.nextRunAt
      const end = input.end
        ? endFields(input.end)
        : { endsAt: existing.endsAt, remainingRuns: existing.remainingRuns }
      yield* assertEndAfterNextRun(end.endsAt, nextRunAt)

      const autoSend = input.autoSend ?? existing.autoSend
      const status =
        existing.status === "active" && autoSend && requiresHumanActivation(command)
          ? "paused"
          : existing.status

      if (cadenceChanged) {
        yield* clearFailedRunAttempts(existing.id)
      }

      // Only fields this edit changes are written, so scheduling progress (`nextRunAt`,
      // `remainingRuns`, `lastRunAt`) is never overwritten with values read earlier.
      const schedule = yield* Effect.promise(() =>
        db.recurringInvoice.update({
          where: { id: existing.id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
            ...(input.items !== undefined ? { items: input.items } : {}),
            ...(input.taxRate !== undefined ? { taxRate: input.taxRate } : {}),
            ...(input.currency !== undefined ? { currency: input.currency } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
            ...(input.dueInDays !== undefined ? { dueInDays: input.dueInDays } : {}),
            ...(cadenceChanged
              ? {
                  startDate: cadence.startDate,
                  intervalCount: cadence.intervalCount,
                  intervalUnit: cadence.intervalUnit,
                  nextRunAt,
                }
              : {}),
            ...(input.end ? end : {}),
            ...(input.autoSend !== undefined ? { autoSend } : {}),
            ...(status !== existing.status ? { status } : {}),
          },
        })
      )

      command.emit({
        aggregateType: "recurring",
        aggregateId: schedule.id,
        type: "recurring.updated",
        payload: { fields: Object.keys(input).filter((key) => key !== "id") },
      })
      emitStatusChange(command, schedule.id, existing.status, status, "awaiting_activation")
      return schedule
    }),
})

export const setRecurringInvoiceStatus = defineCommand({
  type: "recurring.set_status",
  permission: "recurring:update",
  outwardFacing: false,
  input: recurringSetStatusInputSchema,
  summarize: (input) =>
    `${input.status === "paused" ? "Pause" : "End"} recurring schedule ${input.id}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const existing = yield* findScheduleForUpdate(input.id)

      if (existing.status === "ended") {
        return yield* new InvalidState({ message: "The schedule has already ended", code: "schedule_ended" })
      }
      if (existing.status === input.status) {
        return existing
      }

      const schedule = yield* Effect.promise(() =>
        db.recurringInvoice.update({ where: { id: existing.id }, data: { status: input.status } })
      )
      emitStatusChange(command, schedule.id, existing.status, input.status, "manual")
      return schedule
    }),
})

export const resumeRecurringInvoice = defineCommand({
  type: "recurring.resume",
  permission: "recurring:update",
  outwardFacing: true,
  input: recurringIdInputSchema,
  summarize: (input) => `Activate recurring schedule ${input.id}`,
  approvalContext: (input) => recurringApproval(input, "resume"),
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const existing = yield* findScheduleForUpdate(input.id)

      if (existing.status === "ended") {
        return yield* new InvalidState({ message: "Ended schedules cannot be resumed", code: "schedule_ended" })
      }
      if (existing.status === "active") {
        return existing
      }

      // Resuming does not back-bill the paused period: the next run is today or later.
      const nextRunAt = firstRunDateFrom(cadenceOf(existing), command.now, existing.lastRunAt)
      if (existing.endsAt && nextRunAt > existing.endsAt) {
        return yield* new InvalidState({
          message: "The schedule's end date has passed",
          code: "schedule_end_passed",
        })
      }

      yield* clearFailedRunAttempts(existing.id)
      const schedule = yield* Effect.promise(() =>
        db.recurringInvoice.update({
          where: { id: existing.id },
          data: { status: "active", nextRunAt },
        })
      )
      emitStatusChange(command, schedule.id, existing.status, "active", "manual")
      return schedule
    }),
})

/**
 * Generates the invoice for one run of a schedule and advances the schedule, in the caller's
 * transaction. The schedule row is claimed with a conditional update on `nextRunAt`, so two
 * concurrent runs for the same date cannot both proceed; the unique
 * `(recurringInvoiceId, recurringRunDate)` pair backs that up at the database level.
 */
const generateRun = (
  schedule: ScheduleRow,
  runDate: Date,
  /**
   * `inline` sends right after the transaction commits (a person asked for this run now).
   * `queued` only writes the send job to the outbox, so the scheduler's `jobs` task sends it
   * within its time budget instead of the recurring task sending once per generated run.
   */
  autoSendDelivery: "inline" | "queued"
) =>
  Effect.gen(function* () {
    const db = yield* Db
    const command = yield* Command

    if (schedule.endsAt && runDate > schedule.endsAt) {
      yield* Effect.promise(() =>
        db.recurringInvoice.update({ where: { id: schedule.id }, data: { status: "ended" } })
      )
      emitStatusChange(command, schedule.id, schedule.status, "ended", "end_date_reached")
      return { invoice: null, runDate, nextRunAt: schedule.nextRunAt, status: "ended" as const }
    }

    const nextRunAt = advanceRunDate(
      runDate,
      schedule.intervalCount,
      schedule.intervalUnit as IntervalUnit,
      anchorDayOf(schedule.startDate)
    )
    const remainingRuns = schedule.remainingRuns === null ? null : schedule.remainingRuns - 1
    const ended =
      (remainingRuns !== null && remainingRuns <= 0) ||
      (schedule.endsAt !== null && nextRunAt > schedule.endsAt)
    const status = ended ? "ended" : schedule.status

    const claimed = yield* Effect.promise(() =>
      db.recurringInvoice.updateMany({
        where: { id: schedule.id, nextRunAt: runDate, status: schedule.status },
        data: { nextRunAt, remainingRuns, lastRunAt: runDate, status },
      })
    )
    if (claimed.count === 0) {
      return yield* new InvalidState({
        message: "This run was already generated or the schedule changed",
        code: "run_not_due",
      })
    }

    const items = recurringItemsSchema.safeParse(schedule.items)
    if (!items.success) {
      return yield* new InvalidState({
        message: "The schedule's line items are invalid",
        code: "invalid_schedule_items",
      })
    }
    const invoice = yield* buildInvoiceDraft(
      {
        contactId: schedule.contactId,
        dueDate: formatCalendarDate(addUtcDays(runDate, schedule.dueInDays)),
        currency: schedule.currency,
        notes: schedule.notes ?? undefined,
        taxRate: schedule.taxRate.toNumber(),
        items: items.data,
      },
      { recurringInvoiceId: schedule.id, recurringRunDate: runDate }
    )

    command.emit({
      aggregateType: "recurring",
      aggregateId: schedule.id,
      type: "recurring.invoice_generated",
      payload: {
        invoiceId: invoice.id,
        number: invoice.number,
        runDate: formatCalendarDate(runDate),
        autoSend: schedule.autoSend,
      },
    })
    emitStatusChange(command, schedule.id, schedule.status, status, "end_condition_reached")

    if (schedule.autoSend) {
      // Sending runs after this transaction commits, so a failed send keeps the draft.
      const job = {
        type: AUTO_SEND_JOB,
        payload: { invoiceId: invoice.id, recurringInvoiceId: schedule.id },
        dedupeKey: `recurring-auto-send:${invoice.id}`,
      }
      if (autoSendDelivery === "inline") {
        command.enqueue(job)
      } else {
        yield* Effect.promise(() =>
          db.job.upsert({
            where: { dedupeKey: job.dedupeKey },
            create: {
              organizationId: command.organizationId,
              type: job.type,
              payload: job.payload,
              dedupeKey: job.dedupeKey,
              runAfter: command.now,
            },
            update: {},
          })
        )
      }
    }

    return {
      invoice: { id: invoice.id, number: invoice.number },
      runDate,
      nextRunAt,
      status,
    }
  })

export const runRecurringInvoiceNow = defineCommand({
  type: "recurring.run_now",
  permission: "recurring:update",
  outwardFacing: true,
  input: recurringIdInputSchema,
  summarize: (input) => `Generate the next invoice of recurring schedule ${input.id} now`,
  approvalContext: (input) => recurringApproval(input, "run_now"),
  handle: (input) =>
    Effect.gen(function* () {
      const schedule = yield* findScheduleForUpdate(input.id)
      if (schedule.status === "ended") {
        return yield* new InvalidState({ message: "The schedule has ended", code: "schedule_ended" })
      }
      if (schedule.endsAt && schedule.nextRunAt > schedule.endsAt) {
        return yield* new InvalidState({ message: "The schedule has no runs left", code: "schedule_ended" })
      }
      // Pulls the next scheduled run forward rather than adding an extra invoice.
      return yield* generateRun(schedule, schedule.nextRunAt, "inline")
    }),
})

/** Scheduler-only: generates the run for `runDate`. Not exposed to users or agents. */
export const generateRecurringRun = defineCommand({
  type: "recurring.generate_run",
  permission: "recurring:update",
  outwardFacing: false,
  input: z.object({ id: z.string().min(1), runDate: z.iso.datetime() }),
  summarize: (input) => `Generate recurring run ${input.runDate} of schedule ${input.id}`,
  handle: (input) =>
    Effect.gen(function* () {
      const command = yield* Command
      if (command.actor.kind !== "system") {
        return yield* new Forbidden({ message: "Only the scheduler generates scheduled runs" })
      }
      const schedule = yield* findScheduleForUpdate(input.id)
      const runDate = new Date(input.runDate)
      if (schedule.status !== "active" || schedule.nextRunAt.getTime() !== runDate.getTime()) {
        return yield* new InvalidState({
          message: "This run was already generated or the schedule changed",
          code: "run_not_due",
        })
      }
      return yield* generateRun(schedule, runDate, "queued")
    }),
})

/** Scheduler-only: pauses a schedule whose run could not be generated and records why. */
export const recordRecurringRunFailure = defineCommand({
  type: "recurring.record_run_failure",
  permission: "recurring:update",
  outwardFacing: false,
  input: z.object({ id: z.string().min(1), runDate: z.iso.datetime(), error: commandErrorSchema }),
  summarize: (input) => `Pause recurring schedule ${input.id} after a failed run`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const schedule = yield* findScheduleForUpdate(input.id)

      command.emit({
        aggregateType: "recurring",
        aggregateId: schedule.id,
        type: "recurring.run_failed",
        payload: { runDate: input.runDate.slice(0, 10), error: input.error },
      })
      if (schedule.status === "active") {
        yield* Effect.promise(() =>
          db.recurringInvoice.update({ where: { id: schedule.id }, data: { status: "paused" } })
        )
        emitStatusChange(command, schedule.id, "active", "paused", "run_failed")
      }
      return { id: schedule.id }
    }),
})

/** Job-only: keeps an auto-send failure visible on the draft and in the activity log. */
export const recordRecurringAutoSendFailure = defineCommand({
  type: "recurring.record_auto_send_failure",
  permission: "recurring:update",
  outwardFacing: false,
  input: z.object({
    invoiceId: z.string().min(1),
    recurringInvoiceId: z.string().min(1),
    error: commandErrorSchema,
  }),
  summarize: (input) => `Record that invoice ${input.invoiceId} could not be sent automatically`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { organizationId, now } = command

      yield* Effect.promise(() =>
        db.invoice.updateMany({
          // Never replaces the marker of an email that is being delivered; its delivery settles it.
          where: {
            id: input.invoiceId,
            organizationId,
            status: "draft",
            OR: [{ lastEmailAttemptOutcome: null }, { lastEmailAttemptOutcome: { not: "sending" } }],
          },
          data: createEmailDeliveryAttempt({
            at: now,
            outcome: "failed",
            code: input.error.code ?? "auto_send_failed",
            message: `Automatic sending failed: ${input.error.message}`,
          }),
        })
      )
      command.emit({
        aggregateType: "recurring",
        aggregateId: input.recurringInvoiceId,
        type: "recurring.auto_send_failed",
        payload: { invoiceId: input.invoiceId, error: input.error },
      })
      return { invoiceId: input.invoiceId }
    }),
})

const autoSendPayloadSchema = z.object({
  invoiceId: z.string().min(1),
  recurringInvoiceId: z.string().min(1),
})

/*
 * Registered next to the command that enqueues it so every entry point (UI, agents, the
 * scheduler) can run the job right after the generating transaction commits.
 */
registerJobHandler(AUTO_SEND_JOB, async (job) => {
  const parsed = autoSendPayloadSchema.safeParse(job.payload)
  if (!parsed.success) {
    throw new TerminalJobError(`Invalid ${AUTO_SEND_JOB} payload: ${parsed.error.message}`)
  }
  const payload = parsed.data
  const actor = recurringSystemActor(job.organizationId)
  const outcome = await executeCommand(
    sendInvoice,
    { id: payload.invoiceId },
    { actor, clientRequestId: `recurring-send:${payload.invoiceId}` }
  )
  if (outcome.status === "completed" || outcome.status === "awaiting_approval") {
    return
  }
  // Someone sent or deleted the draft in the meantime, or its email is already being delivered
  // (the outbox records that delivery's outcome); there is nothing left to do.
  if (
    outcome.error.code === "not_draft" ||
    outcome.error.code === "send_in_progress" ||
    outcome.error.tag === "NotFound"
  ) {
    return
  }

  await executeCommand(recordRecurringAutoSendFailure, { ...payload, error: outcome.error }, { actor })
  // Provider outages are retried by the job runner. Anything else (a missing recipient, a draft
  // that fails validation or compliance, a lost permission) cannot succeed by retrying: the job
  // fails at once and the draft is left for a person.
  if (outcome.error.tag === "ExternalFailure") {
    throw new Error(outcome.error.message)
  }
  throw new TerminalJobError(outcome.error.message)
})

/** Commands users and agents can run; scheduler-only commands are deliberately not listed. */
export const recurringCommands: readonly AnyCommandDefinition[] = [
  createRecurringInvoice,
  updateRecurringInvoice,
  setRecurringInvoiceStatus,
  resumeRecurringInvoice,
  runRecurringInvoiceNow,
]
