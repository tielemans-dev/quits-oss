import { Effect } from "effect"
import { z } from "zod"
import {
  invoiceRemindersPausedInputSchema,
  parseReminderPolicy,
  reminderPolicyUpdateInputSchema,
  reminderSendNowInputSchema,
  type ReminderPolicy,
} from "@yaip/contracts/reminders"
import type { Prisma } from "../../../generated/prisma/client"
import type { SystemActor } from "../actor"
import { prisma } from "../../lib/db"
import { sendReminderEmail } from "../../lib/emails/reminder-email"
import { appLogger } from "../../lib/observability"
import { getPublicInvoicePaymentUrl } from "../../lib/payments/public"
import type { AnyCommandDefinition } from "../command"
import { defineCommand } from "../command"
import { loadDocumentContext } from "../documents/context"
import { resolveInvoiceEmailContext } from "../documents/invoice-email"
import { computeSettlement } from "../documents/settlement"
import { ExternalFailure, InvalidState, NotFound } from "../errors"
import { Command, Db } from "../services"

const remindersLogger = appLogger.child("reminders")

const DAY_MS = 24 * 60 * 60 * 1000

/** Invoice statuses that can still be chased for payment. */
export const REMINDABLE_STATUSES = ["sent", "viewed", "overdue"] as const

export const REMINDER_SEND_JOB = "reminder.send"

export const SUPERSEDED_MESSAGE = "Superseded by a later reminder"

/** Prefix of the outcome message recorded for reminders sent by hand. */
export const MANUAL_REMINDER_PREFIX = "Sent manually by "

export function isManualReminder(reminder: { outcomeMessage: string | null }) {
  return reminder.outcomeMessage?.startsWith(MANUAL_REMINDER_PREFIX) ?? false
}

export function schedulerActor(organizationId: string): SystemActor {
  return { kind: "system", organizationId, reason: "scheduler", label: "Scheduler" }
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

/** Sends the reminder email; on failure runs `onFailure` outside the transaction first. */
const deliverReminderEmail = (input: {
  invoice: ReminderInvoice
  recipient: string
  /** Stable per reminder so provider-side deduplication covers job retries. */
  idempotencyKey?: string
  onFailure?: () => Promise<unknown>
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

    yield* Effect.tryPromise({
      try: () =>
        sendReminderEmail({
          to: input.recipient,
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
          org: {
            companyName: settings.companyName,
            companyEmail: settings.companyEmail,
            locale: invoice.locale || settings.locale,
            timezone: invoice.timezone || settings.timezone,
          },
          contactName: invoice.contact.name,
          publicPaymentUrl,
        }, { idempotencyKey: input.idempotencyKey }),
      catch: (cause) => cause,
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.promise(() => input.onFailure?.() ?? Promise.resolve()).pipe(
          Effect.flatMap(() =>
            Effect.fail(
              new ExternalFailure({ message: "Failed to send reminder email", service: "email", cause })
            )
          )
        )
      )
    )

    return { balanceDue: balanceDue.toNumber(), hasPublicPaymentUrl: Boolean(publicPaymentUrl) }
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

export const setInvoiceRemindersPaused = defineCommand({
  type: "invoice.set_reminders_paused",
  permission: "invoice:update",
  outwardFacing: false,
  input: invoiceRemindersPausedInputSchema,
  summarize: (input) =>
    `${input.paused ? "Pause" : "Resume"} payment reminders for invoice ${input.invoiceId}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const invoice = yield* findInvoice(input.invoiceId)

      if (invoice.remindersPaused !== input.paused) {
        yield* Effect.promise(() =>
          db.invoice.update({ where: { id: invoice.id }, data: { remindersPaused: input.paused } })
        )
        command.emit({
          aggregateType: "invoice",
          aggregateId: invoice.id,
          type: input.paused ? "invoice.reminders_paused" : "invoice.reminders_resumed",
          payload: { number: invoice.number },
        })
      }
      return { invoiceId: invoice.id, remindersPaused: input.paused }
    }),
})

export const sendReminderNow = defineCommand({
  type: "reminder.send_now",
  permission: "invoice:send",
  outwardFacing: true,
  input: reminderSendNowInputSchema,
  summarize: (input) => `Email a payment reminder for invoice ${input.invoiceId} to the customer`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { now } = command
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
      if (existing && (existing.outcome === null || existing.outcome === "sent")) {
        return yield* new InvalidState({
          message: "A reminder for this invoice was already sent today",
          code: "already_reminded",
        })
      }

      const delivery = yield* deliverReminderEmail({ invoice, recipient })
      const data = {
        scheduledFor: now,
        sentAt: now,
        outcome: "sent",
        outcomeMessage: `${MANUAL_REMINDER_PREFIX}${command.actor.label}`,
      }
      const reminder = yield* Effect.promise(() =>
        existing
          ? db.invoiceReminder.update({ where: { id: existing.id }, data })
          : db.invoiceReminder.create({ data: { invoiceId: invoice.id, offsetDays, ...data } })
      )

      command.emit({
        aggregateType: "invoice",
        aggregateId: invoice.id,
        type: "invoice.reminder_sent",
        payload: {
          number: invoice.number,
          reminderId: reminder.id,
          offsetDays,
          recipient,
          balanceDue: delivery.balanceDue,
          manual: true,
        },
      })
      remindersLogger.info("reminder.sent", {
        organizationId: command.organizationId,
        invoiceId: invoice.id,
        manual: true,
        hasPublicPaymentUrl: delivery.hasPublicPaymentUrl,
      })
      return { reminderId: reminder.id, recipient, sentAt: now }
    }),
})

// ── System commands (scheduler only, never exposed to agents) ─────────

/**
 * Reserves due policy reminders for an organization's open invoices and enqueues one send job
 * per reserved reminder. The `(invoiceId, offsetDays)` unique constraint makes overlapping or
 * repeated ticks harmless.
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
        return { scheduled: 0, skipped: 0 }
      }

      // The earliest reminder fires `min(offset)` days around the due date.
      const horizon = addDays(now, -Math.min(...policy.offsetsDays))
      const invoices = yield* Effect.promise(() =>
        db.invoice.findMany({
          where: {
            organizationId,
            status: { in: [...REMINDABLE_STATUSES] },
            remindersPaused: false,
            dueDate: { lte: horizon },
          },
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
          command.enqueue({
            type: REMINDER_SEND_JOB,
            payload: { reminderId: reminder.id },
            dedupeKey: `reminder:${reminder.id}`,
          })
        }
      }

      return { scheduled, skipped }
    }),
})

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

      const reminder = yield* Effect.promise(() =>
        db.invoiceReminder.findFirst({
          where: { id: input.reminderId, invoice: { organizationId } },
          include: { invoice: { include: reminderInvoiceInclude } },
        })
      )
      if (!reminder) {
        return { reminderId: input.reminderId, outcome: "missing" as const }
      }
      if (reminder.outcome === "sent" || reminder.outcome === "skipped") {
        return { reminderId: reminder.id, outcome: reminder.outcome }
      }

      const { invoice } = reminder
      const { settings } = yield* loadDocumentContext
      const blocker = reminderBlocker(invoice)
      const skipReason =
        blocker === "not_open"
          ? "Invoice is no longer open"
          : blocker === "settled"
            ? "Invoice has no balance due"
            : invoice.remindersPaused
              ? "Reminders are paused for this invoice"
              : !isValidRecipient(invoice.contact.email)
                ? "Contact has no email address"
                : !resolveInvoiceEmailContext(settings).emailDelivery.available
                  ? "Email delivery is not configured"
                  : null

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
      const delivery = yield* deliverReminderEmail({
        invoice,
        recipient,
        idempotencyKey: `yaip-reminder-${reminder.id}`,
        // Written outside the transaction so the failure survives the rollback.
        onFailure: () =>
          prisma.invoiceReminder.update({
            where: { id: reminder.id },
            data: { outcome: "failed", outcomeMessage: "Email delivery failed; retrying" },
          }),
      })

      yield* Effect.promise(() =>
        db.invoiceReminder.update({
          where: { id: reminder.id },
          data: { outcome: "sent", sentAt: now, outcomeMessage: null },
        })
      )
      command.emit({
        aggregateType: "invoice",
        aggregateId: invoice.id,
        type: "invoice.reminder_sent",
        payload: {
          number: invoice.number,
          reminderId: reminder.id,
          offsetDays: reminder.offsetDays,
          recipient,
          balanceDue: delivery.balanceDue,
          manual: false,
        },
      })
      remindersLogger.info("reminder.sent", {
        organizationId,
        invoiceId: invoice.id,
        manual: false,
        hasPublicPaymentUrl: delivery.hasPublicPaymentUrl,
      })
      return { reminderId: reminder.id, outcome: "sent" as const }
    }),
})

/** Owned by the reminders feature. Commands users and agents may run. */
export const reminderCommands: readonly AnyCommandDefinition[] = [
  updateReminderPolicy,
  setInvoiceRemindersPaused,
  sendReminderNow,
]
