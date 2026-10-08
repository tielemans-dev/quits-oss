import { Effect } from "effect"
import { z } from "zod"
import {
  parseReminderPolicy,
  reminderPolicyUpdateInputSchema,
  reminderSendNowInputSchema,
  type ReminderPolicy,
} from "@quits/contracts/reminders"
import { Prisma } from "../../../generated/prisma/client"
import type { SystemActor } from "../actor"
import { composeMessage } from "../../lib/email"
import { buildReminderEmailContent } from "../../lib/emails/reminder-email"
import { appLogger } from "../../lib/observability"
import { getPublicInvoicePaymentUrl } from "../../lib/payments/public"
import type { AnyCommandDefinition } from "../command"
import { defineCommand } from "../command"
import { enqueueEmailDelivery, registerDeliveryCompletion } from "../delivery/outbox"
import { loadDocumentContext } from "../documents/context"
import { fingerprint } from "../approval-contexts"
import { lockDocument } from "../documents/locks"
import { documentEmailOrg, resolveInvoiceEmailContext } from "../documents/invoice-email"
import { computeSettlement } from "../documents/settlement"
import { InvalidState, NotFound } from "../errors"
import { Command, Db } from "../services"
import { reminderSendApproval } from "../approval-contexts"

const remindersLogger = appLogger.child("reminders")

const DAY_MS = 24 * 60 * 60 * 1000

/** Invoice statuses that can still be chased for payment. */
export const REMINDABLE_STATUSES = ["sent", "viewed", "overdue"] as const

export const REMINDER_SEND_JOB = "reminder.send"

export const SUPERSEDED_MESSAGE = "Superseded by a later reminder"
export const POLICY_DISABLED_MESSAGE = "Automatic reminders are turned off"
export const BALANCE_CHANGED_MESSAGE = "The balance due changed after the reminder was queued"
export const OFFSET_REMOVED_MESSAGE = "This reminder is no longer in the reminder policy"

/** Invoices one scheduling command reserves reminders for; the rest are handled next tick. */
export const REMINDER_BATCH_SIZE = 200

/** Prefix of the outcome message recorded for reminders sent by hand. */
export const MANUAL_REMINDER_PREFIX = "Sent manually by "

/**
 * Outcomes of a reminder that may have reached the customer: it counts as sent, is never
 * repeated, and supersedes earlier reminders. `unconfirmed` is a reminder the email provider
 * never confirmed.
 */
export function reminderWentOut(outcome: string | null) {
  return outcome === "sent" || outcome === "unconfirmed"
}

export function isManualReminder(reminder: { outcomeMessage: string | null }) {
  return reminder.outcomeMessage?.startsWith(MANUAL_REMINDER_PREFIX) ?? false
}

/** Provider idempotency key of the manual reminder for one invoice and day. */
export function manualReminderIdempotencyKey(invoiceId: string, offsetDays: number) {
  return `yaip-reminder-manual-${invoiceId}-${offsetDays}`
}

export function schedulerActor(organizationId: string): SystemActor {
  return { kind: "system", organizationId, reason: "scheduler", label: "Scheduler" }
}

/**
 * Timestamp columns hold UTC wall-clock time without a zone, so raw SQL compares a JS date as
 * its UTC wall-clock value whatever the database session's timezone is.
 */
export function utcTimestamp(date: Date) {
  return Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`
}

export function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY_MS)
}

export function isValidRecipient(email: string | null | undefined) {
  return z.string().email().safeParse(email?.trim() ?? "").success
}

type SettlementFields = {
  status: string
  totalGross: Parameters<typeof computeSettlement>[0]["totalGross"]
  amountPaid: Parameters<typeof computeSettlement>[0]["amountPaid"]
  amountCredited: Parameters<typeof computeSettlement>[0]["amountCredited"]
}

/** Why an invoice cannot be reminded, or null when it is open with a balance due. */
export function reminderBlocker(invoice: SettlementFields): "not_open" | "settled" | null {
  if (!(REMINDABLE_STATUSES as readonly string[]).includes(invoice.status)) {
    return "not_open"
  }
  const { balanceDue } = computeSettlement(invoice)
  return balanceDue.greaterThan(0) ? null : "settled"
}

export type ReminderSlot = { offsetDays: number; scheduledFor: Date }

/**
 * Decides which policy reminders are due for one invoice. Only the most recent due reminder
 * is sent; older due ones are skipped so a late-enabled policy or a missed tick never sends a
 * burst of emails. Offsets that fall before the invoice was issued are never reminded.
 */
export function planDueReminders(input: {
  dueDate: Date
  issueDate: Date
  now: Date
  offsetsDays: readonly number[]
  existing: ReadonlyArray<ReminderSlot>
}): { send: ReminderSlot | null; skip: ReminderSlot[] } {
  const taken = new Set(input.existing.map((reminder) => reminder.offsetDays))
  const due = input.offsetsDays
    .map((offsetDays) => ({ offsetDays, scheduledFor: addDays(input.dueDate, offsetDays) }))
    .filter(
      (slot) =>
        !taken.has(slot.offsetDays) &&
        slot.scheduledFor <= input.now &&
        slot.scheduledFor >= input.issueDate
    )
    .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())

  const latest = due.at(-1)
  if (!latest) {
    return { send: null, skip: [] }
  }

  const latestExisting = Math.max(...input.existing.map((reminder) => reminder.scheduledFor.getTime()))
  if (input.existing.length > 0 && latestExisting >= latest.scheduledFor.getTime()) {
    return { send: null, skip: due }
  }
  return { send: latest, skip: due.slice(0, -1) }
}

/** `overdue` wording starts the day after the due date. */
export function reminderStage(dueDate: Date, now: Date): "upcoming" | "overdue" {
  return now.getTime() >= dueDate.getTime() + DAY_MS ? "overdue" : "upcoming"
}

const reminderInvoiceInclude = { contact: { select: { name: true, email: true } } } as const

type ReminderInvoice = Prisma.InvoiceGetPayload<{ include: typeof reminderInvoiceInclude }>

const findInvoice = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    const invoice = yield* Effect.promise(() =>
      db.invoice.findFirst({ where: { id, organizationId }, include: reminderInvoiceInclude })
    )
    if (!invoice) {
      return yield* new NotFound({ message: "Invoice not found", entity: "invoice", id })
    }
    return invoice
  })

const REMINDER_COMPLETION = "reminder"

/**
 * Settles a queued reminder email: a reminder reads "sending" from when it is queued until the
 * provider accepts or refuses it, so a reminder is only recorded as sent once it was delivered.
 */
registerDeliveryCompletion(REMINDER_COMPLETION, {
  pending: async (db, target) =>
    (await db.invoiceReminder.count({
      where: { id: target.reminderId, outcome: "sending", sentAt: new Date(target.attemptAt) },
    })) > 0,
  delivered: async ({ tx, target }) => {
    const manual = target.manual === "true"
    const { count } = await tx.invoiceReminder.updateMany({
      where: { id: target.reminderId, outcome: "sending", sentAt: new Date(target.attemptAt) },
      // A manual reminder keeps its "sent manually by" note.
      data: manual ? { outcome: "sent" } : { outcome: "sent", outcomeMessage: null },
    })
    if (count === 0) return []
    return [
      {
        aggregateType: "invoice",
        aggregateId: target.invoiceId,
        type: "invoice.reminder_sent",
        payload: {
          number: target.number,
          reminderId: target.reminderId,
          offsetDays: Number(target.offsetDays),
          recipient: target.recipient,
          balanceDue: Number(target.balanceDue),
          manual,
        },
      },
    ]
  },
  // Stops a queued reminder that is no longer due a reminder before every request to the provider.
  withdrawalReason: async (db, target) => {
    const reminder = await db.invoiceReminder.findUnique({
      where: { id: target.reminderId },
      select: {
        offsetDays: true,
        outcomeMessage: true,
        invoice: {
          select: {
            status: true,
            totalGross: true,
            amountPaid: true,
            amountCredited: true,
            remindersPaused: true,
            dueDate: true,
            issueDate: true,
            organizationId: true,
            reminders: { select: { offsetDays: true, scheduledFor: true, outcome: true, outcomeMessage: true } },
          },
        },
      },
    })
    if (!reminder) return "The reminder no longer exists"
    const settings = await db.orgSettings.findUnique({
      where: { organizationId: reminder.invoice.organizationId },
      select: { reminderPolicy: true },
    })
    const skip = reminderSkipReason({
      reminder,
      invoice: reminder.invoice,
      policy: parseReminderPolicy(settings?.reminderPolicy ?? null),
      now: new Date(),
    })
    if (skip) return skip
    // The stored email states the balance due when it was queued.
    return computeSettlement(reminder.invoice).balanceDue.toString() === target.balanceDue ? null : BALANCE_CHANGED_MESSAGE
  },
  failed: async ({ tx, target }, failure) => {
    const where = { id: target.reminderId, outcome: "sending", sentAt: new Date(target.attemptAt) }
    const reminder = await tx.invoiceReminder.findFirst({ where, select: { outcomeMessage: true } })
    if (!reminder) return []
    // The customer may have the reminder, so it counts as sent and is never repeated, but it is
    // recorded as unconfirmed rather than sent.
    const data =
      failure.reason === "unconfirmed"
        ? {
            outcome: "unconfirmed",
            outcomeMessage:
              target.manual === "true"
                ? `${reminder.outcomeMessage ?? MANUAL_REMINDER_PREFIX} (delivery not confirmed)`
                : "Delivery was not confirmed by the email provider",
          }
        : failure.reason === "withdrawn" && failure.message === BALANCE_CHANGED_MESSAGE && target.manual !== "true"
          ? // Reserved again and re-queued, so the reminder goes out with the current balance.
            { outcome: null, sentAt: null, outcomeMessage: null }
          : failure.reason === "withdrawn"
            ? { outcome: "skipped", outcomeMessage: failure.message }
          : { outcome: "failed", outcomeMessage: `The email provider refused the reminder: ${failure.message}`.slice(0, 500) }
    await tx.invoiceReminder.updateMany({ where, data })
    if (data.outcome === null) {
      await tx.job.create({
        data: {
          organizationId: (await tx.invoice.findUniqueOrThrow({ where: { id: target.invoiceId } })).organizationId,
          type: REMINDER_SEND_JOB,
          payload: { reminderId: target.reminderId, attempt: target.attemptAt },
          dedupeKey: `reminder:${target.reminderId}:${target.attemptAt}`,
        },
      })
      return []
    }
    return [
      {
        aggregateType: "invoice",
        aggregateId: target.invoiceId,
        type:
          failure.reason === "unconfirmed"
            ? "invoice.reminder_unconfirmed"
            : failure.reason === "withdrawn"
              ? "invoice.reminder_skipped"
              : "invoice.reminder_failed",
        payload: {
          number: target.number,
          reminderId: target.reminderId,
          reason: failure.reason === "withdrawn" ? failure.message : failure.reason,
          message: failure.message,
        },
      },
    ]
  },
})

/**
 * Queues the reminder email for a reserved reminder row, which the caller has marked "sending"
 * with `sentAt` equal to the command's time. The completion above records the outcome.
 */
const queueReminderEmail = (input: {
  invoice: ReminderInvoice
  reminder: { id: string; offsetDays: number }
  recipient: string
  manual: boolean
  /** Names exactly this delivery; the provider drops a repeat sent under the same key. */
  idempotencyKey: string
}) =>
  Effect.gen(function* () {
    const { now } = yield* Command
    const { settings } = yield* loadDocumentContext
    const emailContext = resolveInvoiceEmailContext(settings)
    const { invoice } = input
    const publicPaymentUrl =
      emailContext.stripeConfigured && invoice.publicPaymentIssuedAt
        ? getPublicInvoicePaymentUrl(invoice)
        : null
    const { balanceDue } = computeSettlement(invoice)

    const content = buildReminderEmailContent({
      fromName: emailContext.envelope.fromName,
      fromEmail: emailContext.envelope.fromEmail,
      replyTo: emailContext.envelope.replyTo,
      stage: reminderStage(invoice.dueDate, now),
      invoice: {
        number: invoice.number,
        dueDate: invoice.dueDate,
        currency: invoice.currency,
        balanceDue: balanceDue.toNumber(),
      },
      org: documentEmailOrg(invoice, settings),
      contactName: invoice.contact.name,
      publicPaymentUrl,
    })
    const { deliveryKey } = yield* enqueueEmailDelivery({
      message: composeMessage(input.recipient, content),
      idempotencyKey: input.idempotencyKey,
      completion: {
        kind: REMINDER_COMPLETION,
        target: {
          reminderId: input.reminder.id,
          invoiceId: invoice.id,
          attemptAt: now.toISOString(),
          number: invoice.number,
          recipient: input.recipient,
          offsetDays: String(input.reminder.offsetDays),
          balanceDue: balanceDue.toString(),
          manual: String(input.manual),
        },
      },
    })

    return { balanceDue: balanceDue.toNumber(), hasPublicPaymentUrl: Boolean(publicPaymentUrl), deliveryKey }
  })

export const updateReminderPolicy = defineCommand({
  type: "reminders.update_policy",
  permission: "settings:update",
  outwardFacing: false,
  input: reminderPolicyUpdateInputSchema,
  summarize: (input) =>
    input.enabled
      ? `Enable payment reminders at ${input.offsetsDays.join(", ")} days from the due date`
      : "Disable automatic payment reminders",
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const policy: ReminderPolicy = { enabled: input.enabled, offsetsDays: [...input.offsetsDays] }

      yield* Effect.promise(() =>
        db.orgSettings.upsert({
          where: { organizationId: command.organizationId },
          create: { organizationId: command.organizationId, reminderPolicy: policy },
          update: { reminderPolicy: policy },
        })
      )
      command.emit({
        aggregateType: "organization",
        aggregateId: command.organizationId,
        type: "reminders.policy_updated",
        payload: policy,
      })
      return policy
    }),
})

/** Input of the per-invoice pause and resume commands. */
export const invoiceReminderTargetSchema = z.object({ invoiceId: z.string().min(1) })

/**
 * The next reminder the policy would send for an invoice: the latest offset already due and not
 * yet reserved (sent by the next tick), otherwise the earliest one still to come.
 */
export function nextPolicyReminder(input: {
  dueDate: Date
  issueDate: Date
  now: Date
  policy: ReminderPolicy
  existing: ReadonlyArray<ReminderSlot>
}): ReminderSlot | null {
  if (!input.policy.enabled) {
    return null
  }
  const plan = planDueReminders({ ...input, offsetsDays: input.policy.offsetsDays })
  if (plan.send) {
    return plan.send
  }
  const taken = new Set(input.existing.map((reminder) => reminder.offsetDays))
  return (
    input.policy.offsetsDays
      .map((offsetDays) => ({ offsetDays, scheduledFor: addDays(input.dueDate, offsetDays) }))
      .filter(
        (slot) =>
          !taken.has(slot.offsetDays) && slot.scheduledFor > input.now && slot.scheduledFor >= input.issueDate
      )
      .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())[0] ?? null
  )
}

/**
 * What a person approving "resume reminders" sees. The version fingerprints the reviewed facts
 * (amount owed, due date, recipient), so unrelated writes such as overdue marking do not void it.
 */
export const reminderResumeApproval = (input: { invoiceId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const command = yield* Command
    yield* lockDocument("invoice", input.invoiceId)
    const located = yield* Effect.promise(() =>
      db.invoice.findFirst({
        where: { id: input.invoiceId, organizationId: command.organizationId },
        select: { contactId: true },
      })
    )
    if (!located) {
      return yield* new NotFound({ message: "Invoice not found", entity: "invoice", id: input.invoiceId })
    }
    // Locked so the address the reviewer saw is the address the version was computed from.
    yield* lockDocument("contact", located.contactId, { strength: "no_key_update" })
    const invoice = yield* Effect.promise(() =>
      db.invoice.findFirstOrThrow({
        where: { id: input.invoiceId, organizationId: command.organizationId },
        include: { ...reminderInvoiceInclude, reminders: { select: { offsetDays: true, scheduledFor: true } } },
      })
    )
    const { settings } = yield* loadDocumentContext
    const recipient = invoice.contact.email?.trim() || null
    const next = nextPolicyReminder({
      dueDate: invoice.dueDate,
      issueDate: invoice.issueDate,
      now: command.now,
      policy: parseReminderPolicy(settings.reminderPolicy),
      existing: invoice.reminders,
    })
    const nextDate = next ? (next.scheduledFor <= command.now ? command.now : next.scheduledFor) : null
    const { balanceDue } = computeSettlement(invoice)
    const nextText = nextDate ? `next reminder ${nextDate.toISOString().slice(0, 10)}` : "no reminder scheduled"
    return {
      summary: `Resume automatic payment reminders for invoice ${invoice.number} to ${recipient ?? invoice.contact.name} (${nextText})`,
      version: fingerprint([invoice.number, balanceDue.toString(), invoice.dueDate.toISOString(), recipient]),
      details: {
        number: invoice.number,
        customer: invoice.contact.name,
        recipient,
        balanceDue: balanceDue.toFixed(2),
        currency: invoice.currency,
        nextReminder: nextDate ? nextDate.toISOString().slice(0, 10) : null,
      },
    }
  })

const setRemindersPaused = (invoiceId: string, paused: boolean) =>
  Effect.gen(function* () {
    const db = yield* Db
    const command = yield* Command
    yield* lockDocument("invoice", invoiceId)
    const invoice = yield* findInvoice(invoiceId)

    if (invoice.remindersPaused !== paused) {
      yield* Effect.promise(() => db.invoice.update({ where: { id: invoice.id }, data: { remindersPaused: paused } }))
      command.emit({
        aggregateType: "invoice",
        aggregateId: invoice.id,
        type: paused ? "invoice.reminders_paused" : "invoice.reminders_resumed",
        payload: { number: invoice.number },
      })
    }
    return { invoiceId: invoice.id, remindersPaused: paused }
  })

/** Stops automatic reminders for one invoice. Never outward-facing, so an agent can always stop. */
export const pauseInvoiceReminders = defineCommand({
  type: "invoice.pause_reminders",
  permission: "invoice:update",
  outwardFacing: false,
  input: invoiceReminderTargetSchema,
  summarize: (input) => `Pause payment reminders for invoice ${input.invoiceId}`,
  handle: (input) => setRemindersPaused(input.invoiceId, true),
})

/**
 * Restarts automatic reminders for one invoice. Outward-facing and gated by `invoice:send`,
 * because resuming makes the scheduler email the customer.
 */
export const resumeInvoiceReminders = defineCommand({
  type: "invoice.resume_reminders",
  permission: "invoice:send",
  outwardFacing: true,
  input: invoiceReminderTargetSchema,
  summarize: (input) => `Resume automatic payment reminders to the customer of invoice ${input.invoiceId}`,
  approvalContext: (input) => reminderResumeApproval(input),
  handle: (input) => setRemindersPaused(input.invoiceId, false),
})

export const sendReminderNow = defineCommand({
  type: "reminder.send_now",
  permission: "invoice:send",
  outwardFacing: true,
  input: reminderSendNowInputSchema,
  summarize: (input) => `Email a payment reminder for invoice ${input.invoiceId} to the customer`,
  approvalContext: (input) => reminderSendApproval(input),
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { now } = command
      // Serializes concurrent manual and scheduled reminders for this invoice.
      yield* lockDocument("invoice", input.invoiceId)
      const invoice = yield* findInvoice(input.invoiceId)

      const blocker = reminderBlocker(invoice)
      if (blocker) {
        return yield* new InvalidState({
          message:
            blocker === "settled"
              ? "This invoice has no balance due"
              : "Only issued, unpaid invoices can be reminded",
          code: "not_remindable",
        })
      }
      if (!isValidRecipient(invoice.contact.email)) {
        return yield* new InvalidState({
          message: "Contact has no email address",
          code: "missing_recipient",
        })
      }
      const recipient = invoice.contact.email!.trim()

      const { settings } = yield* loadDocumentContext
      if (!resolveInvoiceEmailContext(settings).emailDelivery.available) {
        return yield* new InvalidState({
          message: "Email delivery is not configured",
          code: "email_unavailable",
        })
      }

      // Manual reminders share the per-offset slot so the scheduler never repeats a reminder
      // for a day that was already covered by hand.
      const offsetDays = Math.floor((now.getTime() - invoice.dueDate.getTime()) / DAY_MS)
      const existing = yield* Effect.promise(() =>
        db.invoiceReminder.findUnique({
          where: { invoiceId_offsetDays: { invoiceId: invoice.id, offsetDays } },
        })
      )
      if (existing && (existing.outcome === null || reminderWentOut(existing.outcome) || existing.outcome === "sending")) {
        return yield* new InvalidState({
          message: "A reminder for this invoice was already sent today",
          code: "already_reminded",
        })
      }

      // Reserve the slot: a concurrent request waits on the invoice lock and then finds this
      // reminder. It reads "sending" until the provider accepts or refuses the queued email.
      const data = {
        scheduledFor: now,
        sentAt: now,
        outcome: "sending",
        outcomeMessage: `${MANUAL_REMINDER_PREFIX}${command.actor.label}`,
      }
      const reminder = yield* Effect.promise(() =>
        existing
          ? db.invoiceReminder.update({ where: { id: existing.id }, data })
          : db.invoiceReminder.create({ data: { invoiceId: invoice.id, offsetDays, ...data } })
      )
      const delivery = yield* queueReminderEmail({
        invoice,
        reminder,
        recipient,
        manual: true,
        idempotencyKey: `${manualReminderIdempotencyKey(invoice.id, offsetDays)}-${now.getTime()}`,
      })
      remindersLogger.info("reminder.queued", {
        organizationId: command.organizationId,
        invoiceId: invoice.id,
        manual: true,
        hasPublicPaymentUrl: delivery.hasPublicPaymentUrl,
      })
      return { reminderId: reminder.id, recipient, sentAt: now, deliveryKey: delivery.deliveryKey }
    }),
})

// ── System commands (scheduler only, never exposed to agents) ─────────

/**
 * Reserves due policy reminders for one batch of an organization's open invoices and queues one
 * send job per reserved reminder; `more` tells the caller another batch is waiting. The
 * `(invoiceId, offsetDays)` unique constraint makes overlapping or repeated ticks harmless.
 */
export const scheduleDueReminders = defineCommand({
  type: "reminder.schedule_due",
  permission: "invoice:send",
  outwardFacing: true,
  input: z.object({}),
  summarize: () => "Schedule due payment reminders",
  handle: () =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { organizationId, now } = command
      const { settings } = yield* loadDocumentContext
      const policy = parseReminderPolicy(settings.reminderPolicy)
      if (!policy.enabled || policy.offsetsDays.length === 0) {
        return { scheduled: 0, skipped: 0, more: false }
      }

      // An invoice needs work when the latest policy offset already due for it has no reminder
      // yet. Selecting only those (in bounded, oldest-first batches) means invoices that are done
      // never fill the batch, so a large backlog drains over a few ticks.
      const offsets = [...policy.offsetsDays].sort((a, b) => a - b)
      const windows = offsets.map((offsetDays, index) => {
        const nextOffset = offsets[index + 1]
        return Prisma.sql`(
          i."dueDate" <= ${utcTimestamp(addDays(now, -offsetDays))}
          ${nextOffset === undefined ? Prisma.empty : Prisma.sql`AND i."dueDate" > ${utcTimestamp(addDays(now, -nextOffset))}`}
          AND i."issueDate" <= i."dueDate" + make_interval(days => ${offsetDays}::int)
          AND NOT EXISTS (
            SELECT 1 FROM "invoice_reminder" r
            WHERE r."invoiceId" = i."id" AND r."offsetDays" = ${offsetDays}::int
          )
        )`
      })
      const batch = yield* Effect.promise(() =>
        db.$queryRaw<Array<{ id: string }>>`
          SELECT i."id" FROM "invoice" i
          JOIN "contact" c ON c."id" = i."contactId"
          WHERE i."organizationId" = ${organizationId}
            AND i."status" IN (${Prisma.join([...REMINDABLE_STATUSES])})
            AND i."remindersPaused" = false
            AND i."totalGross" - i."amountCredited" - i."amountPaid" > 0
            AND NULLIF(TRIM(c."email"), '') IS NOT NULL
            AND (${Prisma.join(windows, " OR ")})
          ORDER BY i."dueDate" ASC, i."id" ASC
          LIMIT ${REMINDER_BATCH_SIZE}
        `
      )
      if (batch.length === 0) {
        return { scheduled: 0, skipped: 0, more: false }
      }

      const invoices = yield* Effect.promise(() =>
        db.invoice.findMany({
          where: { id: { in: batch.map((row) => row.id) }, organizationId },
          orderBy: { dueDate: "asc" },
          select: {
            id: true,
            status: true,
            issueDate: true,
            dueDate: true,
            totalGross: true,
            amountPaid: true,
            amountCredited: true,
            contact: { select: { email: true } },
            reminders: { select: { offsetDays: true, scheduledFor: true } },
          },
        })
      )

      let scheduled = 0
      let skipped = 0
      for (const invoice of invoices) {
        if (reminderBlocker(invoice) || !isValidRecipient(invoice.contact.email)) {
          continue
        }
        const plan = planDueReminders({
          dueDate: invoice.dueDate,
          issueDate: invoice.issueDate,
          now,
          offsetsDays: policy.offsetsDays,
          existing: invoice.reminders,
        })
        if (!plan.send && plan.skip.length === 0) {
          continue
        }

        const created = yield* Effect.promise(() =>
          db.invoiceReminder.createManyAndReturn({
            data: [
              ...plan.skip.map((slot) => ({
                invoiceId: invoice.id,
                ...slot,
                outcome: "skipped",
                outcomeMessage: SUPERSEDED_MESSAGE,
              })),
              ...(plan.send ? [{ invoiceId: invoice.id, ...plan.send }] : []),
            ],
            skipDuplicates: true,
            select: { id: true, offsetDays: true, outcome: true },
          })
        )

        for (const reminder of created) {
          if (reminder.outcome === "skipped") {
            skipped += 1
            continue
          }
          scheduled += 1
          // Written straight to the job outbox in this transaction rather than through
          // `command.enqueue`, which would send every reminder before the tick moves on. The
          // tick's `jobs` task sends them, and later ticks pick up whatever it did not reach.
          yield* Effect.promise(() =>
            db.job.upsert({
              where: { dedupeKey: `reminder:${reminder.id}` },
              create: {
                organizationId,
                type: REMINDER_SEND_JOB,
                payload: { reminderId: reminder.id },
                dedupeKey: `reminder:${reminder.id}`,
                runAfter: now,
              },
              update: {},
            })
          )
        }
      }

      return { scheduled, skipped, more: batch.length === REMINDER_BATCH_SIZE }
    }),
})

/**
 * Why a reserved reminder should no longer go out, or null. The policy is read when sending, not
 * when the reminder was reserved, so turning reminders off or removing an offset also stops
 * reminders already queued. Checked when the reminder is queued and again before every request
 * to the email provider.
 */
export function reminderSkipReason(input: {
  reminder: { offsetDays: number; outcomeMessage: string | null }
  invoice: SettlementFields & {
    remindersPaused: boolean
    dueDate: Date
    issueDate: Date
    reminders: ReadonlyArray<{ offsetDays: number; scheduledFor: Date; outcome: string | null; outcomeMessage: string | null }>
  }
  policy: ReminderPolicy
  now: Date
}): string | null {
  const { reminder, invoice, policy, now } = input
  const followsPolicy = !isManualReminder(reminder)
  const offsetInPolicy = (offsetDays: number) => policy.offsetsDays.includes(offsetDays)
  // A later reminder that went out, or is due and will go out, replaces this one, so a retried
  // older reminder never reaches the customer after a newer one.
  const laterRowSuperseded = invoice.reminders.some(
    (other) =>
      other.offsetDays > reminder.offsetDays &&
      (reminderWentOut(other.outcome) ||
        other.outcome === "sending" ||
        (other.outcome === null &&
          other.scheduledFor <= now &&
          (isManualReminder(other) || (policy.enabled && offsetInPolicy(other.offsetDays)))))
  )
  // A later policy offset that is already due supersedes this reminder even before the scheduler
  // reserved a row for it, e.g. a 7-day job retried after day 14.
  const laterOffsetDue =
    policy.enabled &&
    policy.offsetsDays.some((offsetDays) => {
      const scheduledFor = addDays(invoice.dueDate, offsetDays)
      return offsetDays > reminder.offsetDays && scheduledFor <= now && scheduledFor >= invoice.issueDate
    })
  const blocker = reminderBlocker(invoice)
  return blocker === "not_open"
    ? "Invoice is no longer open"
    : blocker === "settled"
      ? "Invoice has no balance due"
      : followsPolicy && invoice.remindersPaused
        ? "Reminders are paused for this invoice"
        : followsPolicy && !policy.enabled
          ? POLICY_DISABLED_MESSAGE
          : followsPolicy && !offsetInPolicy(reminder.offsetDays)
            ? OFFSET_REMOVED_MESSAGE
            : laterRowSuperseded || laterOffsetDue
              ? SUPERSEDED_MESSAGE
              : null
}

const deliverReminderInputSchema = z.object({ reminderId: z.string().min(1) })

/**
 * Sends one reserved reminder. Re-checks eligibility at send time and records the outcome on
 * the reminder. Sent and skipped reminders are final, so retries never email twice; a failed
 * delivery is recorded and the job retries with backoff.
 */
export const deliverScheduledReminder = defineCommand({
  type: "reminder.deliver",
  permission: "invoice:send",
  outwardFacing: true,
  input: deliverReminderInputSchema,
  summarize: (input) => `Send scheduled reminder ${input.reminderId}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { organizationId, now } = command

      const target = yield* Effect.promise(() =>
        db.invoiceReminder.findFirst({
          where: { id: input.reminderId, invoice: { organizationId } },
          select: { invoiceId: true },
        })
      )
      if (!target) {
        return { reminderId: input.reminderId, outcome: "missing" as const }
      }
      // Serializes with manual reminders and other deliveries for the same invoice, then reads
      // the reminder and its siblings fresh.
      yield* lockDocument("invoice", target.invoiceId)
      const reminder = yield* Effect.promise(() =>
        db.invoiceReminder.findFirst({
          where: { id: input.reminderId, invoice: { organizationId } },
          include: {
            invoice: {
              include: {
                ...reminderInvoiceInclude,
                reminders: { select: { offsetDays: true, scheduledFor: true, outcome: true, outcomeMessage: true } },
              },
            },
          },
        })
      )
      if (!reminder) {
        return { reminderId: input.reminderId, outcome: "missing" as const }
      }
      // Sent (confirmed or not), skipped, and refused reminders are final; a "sending" one is
      // already queued.
      if (
        reminder.outcome === "sent" ||
        reminder.outcome === "unconfirmed" ||
        reminder.outcome === "skipped" ||
        reminder.outcome === "sending" ||
        reminder.outcome === "failed"
      ) {
        return { reminderId: reminder.id, outcome: reminder.outcome }
      }

      const { invoice } = reminder
      const { settings } = yield* loadDocumentContext
      const skipReason =
        reminderSkipReason({ reminder, invoice, policy: parseReminderPolicy(settings.reminderPolicy), now }) ??
        (!isValidRecipient(invoice.contact.email)
          ? "Contact has no email address"
          : !resolveInvoiceEmailContext(settings).emailDelivery.available
            ? "Email delivery is not configured"
            : null)

      if (skipReason) {
        yield* Effect.promise(() =>
          db.invoiceReminder.update({
            where: { id: reminder.id },
            data: { outcome: "skipped", outcomeMessage: skipReason },
          })
        )
        command.emit({
          aggregateType: "invoice",
          aggregateId: invoice.id,
          type: "invoice.reminder_skipped",
          payload: { number: invoice.number, reminderId: reminder.id, reason: skipReason },
        })
        return { reminderId: reminder.id, outcome: "skipped" as const }
      }

      const recipient = invoice.contact.email!.trim()
      yield* Effect.promise(() =>
        db.invoiceReminder.update({
          where: { id: reminder.id },
          data: { outcome: "sending", sentAt: now, outcomeMessage: null },
        })
      )
      const delivery = yield* queueReminderEmail({
        invoice,
        reminder,
        recipient,
        manual: false,
        idempotencyKey: `yaip-reminder-${reminder.id}-${now.getTime()}`,
      })
      remindersLogger.info("reminder.queued", {
        organizationId,
        invoiceId: invoice.id,
        manual: false,
        hasPublicPaymentUrl: delivery.hasPublicPaymentUrl,
      })
      return { reminderId: reminder.id, outcome: "sending" as const }
    }),
})

/** Owned by the reminders feature. Commands users and agents may run. */
export const reminderCommands: readonly AnyCommandDefinition[] = [
  updateReminderPolicy,
  pauseInvoiceReminders,
  resumeInvoiceReminders,
  sendReminderNow,
]
