import { z } from "zod"
import {
  recurringCreateInputSchema,
  recurringIdInputSchema,
  recurringSetStatusInputSchema,
  recurringUpdateInputSchema,
} from "@yaip/contracts/recurring"
import { prisma } from "../../../lib/db"
import {
  createRecurringInvoice,
  resumeRecurringInvoice,
  runRecurringInvoiceNow,
  setRecurringInvoiceStatus,
  updateRecurringInvoice,
} from "../../commands/recurring"
import { defineCommandTool, defineQueryTool, type AgentTool } from "../define"

export const recurringTools: AgentTool[] = [
  defineQueryTool({
    name: "recurring_list",
    title: "List recurring invoices",
    description:
      "Lists recurring invoice schedules with cadence, next run date, status, and whether generated " +
      "invoices are sent automatically.",
    input: z.object({ status: z.enum(["active", "paused", "ended"]).optional() }),
    permission: "recurring:read",
    run: async ({ actor }, input) =>
      prisma.recurringInvoice.findMany({
        where: { organizationId: actor.organizationId, ...(input.status ? { status: input.status } : {}) },
        include: { contact: { select: { id: true, name: true } } },
        orderBy: [{ status: "asc" }, { nextRunAt: "asc" }],
        take: 200,
      }),
  }),

  defineCommandTool({
    name: "recurring_create",
    title: "Create recurring invoice",
    description:
      "Creates a schedule that generates an invoice every interval. With an approval_required key an " +
      "auto-sending schedule is saved paused; turn it on with recurring_resume, which needs approval.",
    command: createRecurringInvoice,
    input: recurringCreateInputSchema,
  }),

  defineCommandTool({
    name: "recurring_update",
    title: "Update recurring invoice",
    description:
      "Changes a schedule. With an approval_required key, editing an active auto-sending schedule " +
      "pauses it until a person resumes it.",
    command: updateRecurringInvoice,
    input: recurringUpdateInputSchema,
  }),

  defineCommandTool({
    name: "recurring_set_status",
    title: "Pause or end recurring invoice",
    description: "Pauses or ends a schedule. Stopping never needs approval.",
    command: setRecurringInvoiceStatus,
    input: recurringSetStatusInputSchema,
  }),

  defineCommandTool({
    name: "recurring_resume",
    title: "Resume recurring invoice",
    description: "Turns a paused schedule back on. It does not bill the paused period.",
    command: resumeRecurringInvoice,
    input: recurringIdInputSchema,
  }),

  defineCommandTool({
    name: "recurring_run_now",
    title: "Generate next recurring invoice now",
    description: "Generates the next scheduled invoice early and moves the schedule on.",
    command: runRecurringInvoiceNow,
    input: recurringIdInputSchema,
  }),
]
