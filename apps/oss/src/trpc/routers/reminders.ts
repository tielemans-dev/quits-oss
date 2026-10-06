import { TRPCError } from "@trpc/server"
import {
  invoiceRemindersPausedInputSchema,
  invoiceRemindersQuerySchema,
  parseReminderPolicy,
  reminderPolicyUpdateInputSchema,
  reminderSendNowInputSchema,
  type InvoiceReminderRecord,
  type ReminderStatus,
} from "@yaip/contracts/reminders"
import {
  addDays,
  isManualReminder,
  isValidRecipient,
  reminderBlocker,
  sendReminderNow,
  setInvoiceRemindersPaused,
  updateReminderPolicy,
} from "../../domain/commands/reminders"
import { executeCommand } from "../../domain/execute"
import { prisma } from "../../lib/db"
import { authorizedProcedure, router } from "../init"
import { unwrapOutcome } from "../outcome"

function storedStatus(outcome: string | null): ReminderStatus {
  return outcome === "sent" || outcome === "failed" || outcome === "skipped" ? outcome : "scheduled"
}

async function readPolicy(organizationId: string) {
  const settings = await prisma.orgSettings.findUnique({
    where: { organizationId },
    select: { reminderPolicy: true },
  })
  return parseReminderPolicy(settings?.reminderPolicy)
}

export const remindersRouter = router({
  getPolicy: authorizedProcedure("settings:read").query(({ ctx }) => readPolicy(ctx.organizationId)),

  updatePolicy: authorizedProcedure("settings:update")
    .input(reminderPolicyUpdateInputSchema)
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(updateReminderPolicy, input, { actor: ctx.actor }))
    ),

  /** Reminder history for one invoice plus the policy reminders still to come. */
  listForInvoice: authorizedProcedure("invoice:read")
    .input(invoiceRemindersQuerySchema)
    .query(async ({ ctx, input }) => {
      const invoice = await prisma.invoice.findFirst({
        where: { id: input.invoiceId, organizationId: ctx.organizationId },
        select: {
          id: true,
          status: true,
          issueDate: true,
          dueDate: true,
          totalGross: true,
          amountPaid: true,
          amountCredited: true,
          remindersPaused: true,
          contact: { select: { email: true } },
          reminders: { orderBy: { scheduledFor: "asc" } },
        },
      })
      if (!invoice) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" })
      }

      const policy = await readPolicy(ctx.organizationId)
      const blocker = reminderBlocker(invoice)
      const now = new Date()
      const records: InvoiceReminderRecord[] = invoice.reminders.map((reminder) => ({
        id: reminder.id,
        offsetDays: reminder.offsetDays,
        scheduledFor: reminder.scheduledFor,
        sentAt: reminder.sentAt,
        status: storedStatus(reminder.outcome),
        manual: isManualReminder(reminder),
        message: isManualReminder(reminder) ? null : reminder.outcomeMessage,
      }))

      if (policy.enabled && !invoice.remindersPaused && !blocker) {
        const taken = new Set(invoice.reminders.map((reminder) => reminder.offsetDays))
        for (const offsetDays of policy.offsetsDays) {
          const scheduledFor = addDays(invoice.dueDate, offsetDays)
          if (!taken.has(offsetDays) && scheduledFor > now && scheduledFor >= invoice.issueDate) {
            records.push({
              id: null,
              offsetDays,
              scheduledFor,
              sentAt: null,
              status: "upcoming",
              manual: false,
              message: null,
            })
          }
        }
      }
      records.sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())

      return {
        invoiceId: invoice.id,
        remindersPaused: invoice.remindersPaused,
        policyEnabled: policy.enabled,
        remindable: blocker === null,
        hasRecipient: isValidRecipient(invoice.contact.email),
        reminders: records,
      }
    }),

  setPaused: authorizedProcedure("invoice:update")
    .input(invoiceRemindersPausedInputSchema)
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(setInvoiceRemindersPaused, input, { actor: ctx.actor }))
    ),

  sendNow: authorizedProcedure("invoice:send")
    .input(reminderSendNowInputSchema)
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(sendReminderNow, input, { actor: ctx.actor }))
    ),
})
