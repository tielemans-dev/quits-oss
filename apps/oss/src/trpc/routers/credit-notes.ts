import { TRPCError } from "@trpc/server"
import {
  creditNoteIdInputSchema,
  creditNoteIssueInputSchema,
  creditNoteListInputSchema,
  creditNoteSendInputSchema,
} from "@yaip/contracts/credit-notes"
import { z } from "zod"
import {
  creditAvailabilityFor,
  creditTaxRate,
  issueCreditNote,
  sendCreditNote,
} from "../../domain/commands/credit-notes"
import { actorCan } from "../../domain/actor"
import { executeCommand } from "../../domain/execute"
import { prisma } from "../../lib/db"
import { authorizedProcedure, router } from "../init"
import { readEmailDelivery } from "../email-delivery-result"
import { unwrapOutcome } from "../outcome"

type Decimalish = { toNumber(): number }

const num = (value: Decimalish) => value.toNumber()

function serializeItem(item: {
  id: string
  invoiceItemId: string | null
  description: string
  quantity: Decimalish
  unitPriceNet: Decimalish
  unitPriceGross: Decimalish
  lineNet: Decimalish
  lineTax: Decimalish
  lineGross: Decimalish
  taxRate: Decimalish
  sortOrder: number
}) {
  return {
    id: item.id,
    invoiceItemId: item.invoiceItemId,
    description: item.description,
    quantity: num(item.quantity),
    unitPriceNet: num(item.unitPriceNet),
    unitPrice: num(item.unitPriceGross),
    lineNet: num(item.lineNet),
    lineTax: num(item.lineTax),
    total: num(item.lineGross),
    taxRate: num(item.taxRate),
    sortOrder: item.sortOrder,
  }
}

function serializeTotals(creditNote: { subtotalNet: Decimalish; totalTax: Decimalish; totalGross: Decimalish }) {
  return {
    subtotal: num(creditNote.subtotalNet),
    taxAmount: num(creditNote.totalTax),
    total: num(creditNote.totalGross),
  }
}

const listInclude = {
  invoice: { select: { id: true, number: true } },
  contact: { select: { id: true, name: true } },
} as const

export const creditNotesRouter = router({
  list: authorizedProcedure("creditNote:read")
    .input(creditNoteListInputSchema)
    .query(async ({ ctx, input }) => {
      const creditNotes = await prisma.creditNote.findMany({
        where: {
          organizationId: ctx.organizationId,
          ...(input?.invoiceId ? { invoiceId: input.invoiceId } : {}),
        },
        include: listInclude,
        orderBy: [{ issueDate: "desc" }, { number: "desc" }],
      })

      return creditNotes.map((creditNote) => ({
        id: creditNote.id,
        number: creditNote.number,
        status: creditNote.status,
        reason: creditNote.reason,
        issueDate: creditNote.issueDate,
        currency: creditNote.currency,
        invoice: creditNote.invoice,
        contact: creditNote.contact,
        lastEmailAttemptAt: creditNote.lastEmailAttemptAt,
        lastEmailAttemptOutcome: creditNote.lastEmailAttemptOutcome,
        ...serializeTotals(creditNote),
      }))
    }),

  get: authorizedProcedure("creditNote:read")
    .input(creditNoteIdInputSchema)
    .query(async ({ ctx, input }) => {
      const creditNote = await prisma.creditNote.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          invoice: { select: { id: true, number: true, issueDate: true } },
          contact: true,
          items: { orderBy: { sortOrder: "asc" } },
        },
      })
      if (!creditNote) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Credit note not found" })
      }

      const { subtotalNet: _net, totalTax: _tax, totalGross: _gross, items, ...rest } = creditNote
      return { ...rest, ...serializeTotals(creditNote), items: items.map(serializeItem) }
    }),

  /** What can still be credited on an invoice, for the create dialog. */
  availability: authorizedProcedure("creditNote:read")
    .input(z.object({ invoiceId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const invoice = await prisma.invoice.findFirst({
        where: { id: input.invoiceId, organizationId: ctx.organizationId },
        include: {
          items: { orderBy: { sortOrder: "asc" } },
          creditNotes: { where: { status: "issued" }, include: { items: true } },
        },
      })
      if (!invoice) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" })
      }

      const availability = creditAvailabilityFor(invoice)

      return {
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        invoiceStatus: invoice.status,
        currency: invoice.currency,
        locale: invoice.locale,
        taxRate: creditTaxRate(invoice),
        availability,
      }
    }),

  issue: authorizedProcedure("creditNote:create")
    .input(creditNoteIssueInputSchema)
    .mutation(async ({ ctx, input }) => {
      const creditNote = unwrapOutcome(await executeCommand(issueCreditNote, input, { actor: ctx.actor }))
      return { id: creditNote.id, number: creditNote.number, total: num(creditNote.totalGross) }
    }),

  send: authorizedProcedure("creditNote:send")
    .input(creditNoteSendInputSchema)
    .mutation(async ({ ctx, input }) => {
      const result = unwrapOutcome(await executeCommand(sendCreditNote, input, { actor: ctx.actor }))
      // This send's own outcome; the credit note may already show a later attempt.
      return {
        id: result.id,
        recipient: result.recipient,
        attemptedAt: result.lastEmailAttemptAt,
        delivery: await readEmailDelivery(result.deliveryKey, "credit note"),
      }
    }),

  /** What the current user may do with credit notes, so the UI only offers controls the server allows. */
  capabilities: authorizedProcedure("creditNote:read").query(({ ctx }) => ({
    canCreate: actorCan(ctx.actor, "creditNote:create"),
    canSend: actorCan(ctx.actor, "creditNote:send"),
  })),
})
