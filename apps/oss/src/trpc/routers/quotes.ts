import { z } from "zod"
import {
  quoteCreateDraftInputSchema,
  quoteSendInputSchema,
  quoteUpdateDraftInputSchema,
} from "@yaip/contracts/quotes"
import {
  convertQuoteToInvoice,
  createQuoteDraft,
  deleteQuoteDraft,
  rejectQuote,
  resendQuoteEmail,
  sendQuote,
  updateQuoteDraft,
} from "../../domain/commands/quotes"
import { executeCommand } from "../../domain/execute"
import { prisma } from "../../lib/db"
import { getPublicQuoteUrl } from "../../lib/quotes/public-url"
import { router, authorizedProcedure } from "../init"
import { unwrapOutcome } from "../outcome"

function mapQuoteItemForUi(item: {
  quantity: { toNumber: () => number }
  unitPriceGross: { toNumber: () => number }
  lineGross: { toNumber: () => number }
}) {
  return {
    quantity: item.quantity.toNumber(),
    unitPrice: item.unitPriceGross.toNumber(),
    total: item.lineGross.toNumber(),
  }
}

/** Quotes and the invoices converted from them share one UI shape. */
function serializeDocumentForUi<
  Document extends {
    subtotalNet: { toNumber: () => number }
    totalTax: { toNumber: () => number }
    totalGross: { toNumber: () => number }
    items: Array<Parameters<typeof mapQuoteItemForUi>[0]>
  },
>(document: Document) {
  return {
    ...document,
    subtotal: document.subtotalNet.toNumber(),
    taxAmount: document.totalTax.toNumber(),
    total: document.totalGross.toNumber(),
    items: document.items.map((item) => ({ ...item, ...mapQuoteItemForUi(item) })),
  }
}

export const quotesRouter = router({
  list: authorizedProcedure("quote:read")
    .input(
      z
        .object({
          status: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const where: Record<string, unknown> = {
        organizationId: ctx.organizationId,
      }
      if (input?.status) where.status = input.status

      const quotes = await prisma.quote.findMany({
        where,
        include: { contact: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      })

      return quotes.map((quote) => ({
        ...quote,
        subtotal: quote.subtotalNet.toNumber(),
        taxAmount: quote.totalTax.toNumber(),
        total: quote.totalGross.toNumber(),
      }))
    }),

  get: authorizedProcedure("quote:read")
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const quote = await prisma.quote.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          contact: true,
          items: { orderBy: { sortOrder: "asc" } },
          invoices: { select: { id: true, number: true } },
        },
      })

      return {
        ...quote,
        subtotal: quote.subtotalNet.toNumber(),
        taxAmount: quote.totalTax.toNumber(),
        total: quote.totalGross.toNumber(),
        publicViewUrl: getPublicQuoteUrl(quote),
        items: quote.items.map((item) => ({
          ...item,
          ...mapQuoteItemForUi(item),
        })),
      }
    }),

  create: authorizedProcedure("quote:create")
    .input(quoteCreateDraftInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeDocumentForUi(
        unwrapOutcome(await executeCommand(createQuoteDraft, input, { actor: ctx.actor }))
      )
    ),

  update: authorizedProcedure("quote:update")
    .input(quoteUpdateDraftInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeDocumentForUi(
        unwrapOutcome(await executeCommand(updateQuoteDraft, input, { actor: ctx.actor }))
      )
    ),

  delete: authorizedProcedure("quote:delete")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(deleteQuoteDraft, input, { actor: ctx.actor }))
    ),

  send: authorizedProcedure("quote:send")
    .input(quoteSendInputSchema)
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(sendQuote, input, { actor: ctx.actor }))
    ),

  resendEmail: authorizedProcedure("quote:send")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(resendQuoteEmail, input, { actor: ctx.actor }))
    ),

  reject: authorizedProcedure("quote:update")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(rejectQuote, input, { actor: ctx.actor }))
    ),

  convertToInvoice: authorizedProcedure("invoice:create")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) =>
      serializeDocumentForUi(
        unwrapOutcome(await executeCommand(convertQuoteToInvoice, input, { actor: ctx.actor }))
      )
    ),
})
