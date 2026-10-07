import { z } from "zod"
import {
  recurringCreateInputSchema,
  recurringIdInputSchema,
  recurringSetStatusInputSchema,
  recurringUpdateInputSchema,
} from "@quits/contracts/recurring"
import { prisma } from "../../../lib/db"
import {
  createRecurringInvoice,
  resumeRecurringInvoice,
  runRecurringInvoiceNow,
  setRecurringInvoiceStatus,
  updateRecurringInvoice,
} from "../../commands/recurring"
import { defineCommandTool, defineQueryTool, type AgentTool } from "../define"
import { afterNewest, decodeCursor, toPage } from "../pagination"

export const recurringTools: AgentTool[] = [
  defineQueryTool({
    name: "recurring_list",
    title: "List recurring invoices",
    description:
      "Lists recurring invoice schedules, newest first, with cadence, next run date, status, and " +
      "whether generated invoices are sent automatically. Returns { items, nextCursor }.",
    input: z.object({
      status: z.enum(["active", "paused", "ended"]).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z.string().trim().max(500).optional(),
    }),
    permission: "recurring:read",
    run: async ({ actor }, input) => {
      const rows = await prisma.recurringInvoice.findMany({
        where: {
          organizationId: actor.organizationId,
          ...(input.status ? { status: input.status } : {}),
          ...afterNewest(decodeCursor(input.cursor)),
        },
        include: { contact: { select: { id: true, name: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
      })
      return toPage(rows, input.limit, (row) => row.createdAt.toISOString())
    },
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
    description:
      "Turns a paused schedule back on. It does not bill the paused period. Needs approval only " +
      "when the schedule sends invoices automatically (autoSend).",
    command: resumeRecurringInvoice,
    input: recurringIdInputSchema,
  }),

  defineCommandTool({
    name: "recurring_run_now",
    title: "Generate next recurring invoice now",
    description:
      "Generates the next scheduled invoice early and moves the schedule on. Needs approval only " +
      "when the schedule sends invoices automatically (autoSend); otherwise the invoice is kept as a draft.",
    command: runRecurringInvoiceNow,
    input: recurringIdInputSchema,
  }),
]
