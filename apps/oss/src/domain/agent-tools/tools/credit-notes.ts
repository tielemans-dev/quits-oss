import { z } from "zod"
import { creditNoteLineSelectionSchema, creditNoteSendInputSchema } from "@quits/contracts/credit-notes"
import { prisma } from "../../../lib/db"
import type { CommandDefinition } from "../../command"
import { issueCreditNote, sendCreditNote } from "../../commands/credit-notes"
import { NotFound } from "../../errors"
import { defineCommandTool, defineQueryTool, type AgentTool } from "../define"
import { afterNewest, decodeCursor, toPage } from "../pagination"

/**
 * MCP tool inputs must be a single object, so the issue modes are flattened here; the command
 * still validates the exact shape per mode.
 */
const creditNoteIssueToolInputSchema = z.object({
  invoiceId: z.string().min(1),
  reason: z.string().trim().min(1).max(500).describe("Why the invoice is being credited; shown on the credit note"),
  mode: z
    .enum(["full", "lines", "amount"])
    .describe("full: everything still uncredited; lines: chosen lines and quantities; amount: a gross amount"),
  lines: z.array(creditNoteLineSelectionSchema).min(1).max(100).optional().describe("Required when mode is lines"),
  amount: z.number().positive().optional().describe("Gross amount; required when mode is amount"),
})

const creditNoteSummary = {
  id: true,
  number: true,
  invoiceId: true,
  status: true,
  reason: true,
  issueDate: true,
  subtotalNet: true,
  totalTax: true,
  totalGross: true,
  currency: true,
  lastEmailAttemptOutcome: true,
} as const

export const creditNoteTools: AgentTool[] = [
  defineQueryTool({
    name: "credit_notes_list",
    title: "List credit notes",
    description:
      "Lists credit notes, newest first. Pass invoiceId to see the credit notes for one invoice. " +
      "Returns { items, nextCursor }; pass nextCursor to get the next page.",
    input: z.object({
      invoiceId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z.string().trim().max(500).optional(),
    }),
    permission: "creditNote:read",
    run: async ({ actor }, input) => {
      const rows = await prisma.creditNote.findMany({
        where: {
          organizationId: actor.organizationId,
          ...(input.invoiceId ? { invoiceId: input.invoiceId } : {}),
          ...afterNewest(decodeCursor(input.cursor)),
        },
        select: { ...creditNoteSummary, createdAt: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
      })
      return toPage(rows, input.limit, (row) => row.createdAt.toISOString())
    },
  }),

  defineQueryTool({
    name: "credit_note_get",
    title: "Get credit note",
    description: "Returns one credit note with its lines and the invoice it credits.",
    input: z.object({ id: z.string().min(1) }),
    permission: "creditNote:read",
    run: async ({ actor }, input) => {
      const creditNote = await prisma.creditNote.findFirst({
        where: { id: input.id, organizationId: actor.organizationId },
        include: {
          items: { orderBy: { sortOrder: "asc" } },
          invoice: { select: { id: true, number: true } },
          contact: { select: { id: true, name: true, email: true } },
        },
      })
      if (!creditNote) {
        throw new NotFound({ message: "Credit note not found", entity: "creditNote", id: input.id })
      }
      return creditNote
    },
  }),

  defineCommandTool({
    name: "credit_note_issue",
    title: "Issue credit note",
    description:
      "Credits an issued invoice. This is how a sent invoice is corrected or cancelled; it cannot be " +
      "edited or deleted. Credit notes are permanent and numbered. Use invoice_get first to see line ids.",
    // The flat tool input is wider than the command's union; executeCommand validates it against
    // the command's own schema, so a malformed mode combination is rejected there.
    command: issueCreditNote as unknown as CommandDefinition<
      z.output<typeof creditNoteIssueToolInputSchema>,
      unknown
    >,
    input: creditNoteIssueToolInputSchema,
  }),

  defineCommandTool({
    name: "credit_note_send",
    title: "Email credit note",
    description: "Emails a credit note to the customer of the credited invoice. The email is queued and delivered right away; lastEmailAttempt reads \"sending\" until the email provider accepts it, so check it before trying again.",
    command: sendCreditNote,
    input: creditNoteSendInputSchema,
  }),
]
