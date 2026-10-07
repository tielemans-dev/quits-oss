import { TRPCError } from "@trpc/server"
import {
  recurringCreateInputSchema,
  recurringIdInputSchema,
  recurringItemsSchema,
  recurringSetStatusInputSchema,
  recurringUpdateInputSchema,
} from "@quits/contracts/recurring"
import type { Prisma } from "../../../generated/prisma/client"
import {
  createRecurringInvoice,
  resumeRecurringInvoice,
  runRecurringInvoiceNow,
  setRecurringInvoiceStatus,
  updateRecurringInvoice,
} from "../../domain/commands/recurring"
import { actorCan } from "../../domain/actor"
import { executeCommand } from "../../domain/execute"
import { prisma } from "../../lib/db"
import { authorizedProcedure, router } from "../init"
import { unwrapOutcome } from "../outcome"

type ScheduleRow = Prisma.RecurringInvoiceGetPayload<object>

/** Plain numbers and parsed line items for the UI. */
function serializeSchedule(schedule: ScheduleRow) {
  const parsed = recurringItemsSchema.safeParse(schedule.items)
  const items = parsed.success ? parsed.data : []
  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
  return {
    id: schedule.id,
    name: schedule.name,
    contactId: schedule.contactId,
    status: schedule.status as "active" | "paused" | "ended",
    intervalCount: schedule.intervalCount,
    intervalUnit: schedule.intervalUnit as "week" | "month" | "year",
    startDate: schedule.startDate,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    endsAt: schedule.endsAt,
    remainingRuns: schedule.remainingRuns,
    dueInDays: schedule.dueInDays,
    autoSend: schedule.autoSend,
    currency: schedule.currency,
    taxRate: schedule.taxRate.toNumber(),
    notes: schedule.notes,
    items,
    subtotal,
    createdAt: schedule.createdAt,
  }
}

const generatedInvoiceSelect = {
  id: true,
  number: true,
  status: true,
  paymentStatus: true,
  recurringRunDate: true,
  dueDate: true,
  totalGross: true,
  currency: true,
  lastEmailAttemptOutcome: true,
  lastEmailAttemptMessage: true,
} as const

function serializeGeneratedInvoice(
  invoice: Prisma.InvoiceGetPayload<{ select: typeof generatedInvoiceSelect }>
) {
  return { ...invoice, total: invoice.totalGross.toNumber() }
}

export const recurringRouter = router({
  list: authorizedProcedure("recurring:read").query(async ({ ctx }) => {
    const schedules = await prisma.recurringInvoice.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: [{ status: "asc" }, { nextRunAt: "asc" }],
      include: {
        contact: { select: { id: true, name: true } },
        invoices: {
          select: generatedInvoiceSelect,
          orderBy: { recurringRunDate: "desc" },
          take: 1,
        },
        _count: { select: { invoices: true } },
      },
    })

    return schedules.map((schedule) => ({
      ...serializeSchedule(schedule),
      contact: schedule.contact,
      lastInvoice: schedule.invoices[0] ? serializeGeneratedInvoice(schedule.invoices[0]) : null,
      invoiceCount: schedule._count.invoices,
    }))
  }),

  get: authorizedProcedure("recurring:read")
    .input(recurringIdInputSchema)
    .query(async ({ ctx, input }) => {
      const schedule = await prisma.recurringInvoice.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          contact: { select: { id: true, name: true, email: true } },
          invoices: { select: generatedInvoiceSelect, orderBy: { recurringRunDate: "desc" } },
        },
      })
      if (!schedule) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Recurring schedule not found" })
      }

      const lastProblem = await prisma.domainEvent.findFirst({
        where: {
          organizationId: ctx.organizationId,
          aggregateType: "recurring",
          aggregateId: schedule.id,
          type: { in: ["recurring.run_failed", "recurring.auto_send_failed"] },
        },
        orderBy: { sequence: "desc" },
        select: { type: true, payload: true, occurredAt: true },
      })
      const problemError = (lastProblem?.payload as { error?: { message?: string } } | null)?.error

      return {
        ...serializeSchedule(schedule),
        contact: schedule.contact,
        invoices: schedule.invoices.map(serializeGeneratedInvoice),
        lastProblem: lastProblem
          ? {
              type: lastProblem.type,
              message: problemError?.message ?? "",
              occurredAt: lastProblem.occurredAt,
            }
          : null,
      }
    }),

  create: authorizedProcedure("recurring:create")
    .input(recurringCreateInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeSchedule(
        unwrapOutcome(await executeCommand(createRecurringInvoice, input, { actor: ctx.actor }))
      )
    ),

  update: authorizedProcedure("recurring:update")
    .input(recurringUpdateInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeSchedule(
        unwrapOutcome(await executeCommand(updateRecurringInvoice, input, { actor: ctx.actor }))
      )
    ),

  setStatus: authorizedProcedure("recurring:update")
    .input(recurringSetStatusInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeSchedule(
        unwrapOutcome(await executeCommand(setRecurringInvoiceStatus, input, { actor: ctx.actor }))
      )
    ),

  resume: authorizedProcedure("recurring:update")
    .input(recurringIdInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeSchedule(
        unwrapOutcome(await executeCommand(resumeRecurringInvoice, input, { actor: ctx.actor }))
      )
    ),

  runNow: authorizedProcedure("recurring:update")
    .input(recurringIdInputSchema)
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(runRecurringInvoiceNow, input, { actor: ctx.actor }))
    ),

  /** What the current user may do with schedules, so the UI only offers controls the server allows. */
  capabilities: authorizedProcedure("recurring:read").query(({ ctx }) => ({
    canCreate: actorCan(ctx.actor, "recurring:create"),
    canUpdate: actorCan(ctx.actor, "recurring:update"),
  })),
})
