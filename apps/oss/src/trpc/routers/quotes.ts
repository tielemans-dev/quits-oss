import { TRPCError } from "@trpc/server"
import { loadDocumentView } from "../../domain/documents/view"
import { previewNextDocumentNumber } from "../../domain/documents/number-preview"
import { z } from "zod"
import {
  quoteCreateDraftInputSchema,
  quoteCreateDraftV2InputSchema,
  quoteSendInputSchema,
  quoteUpdateDraftInputSchema,
  quoteUpdateDraftV2InputSchema,
} from "@quits/contracts/quotes"
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
import { documentDisplayForUi, lineDisplayForUi } from "./document-display"
import { settleEmailResult } from "../email-delivery-result"
import { unwrapOutcome } from "../outcome"

function mapQuoteItemForUi(
  item: {
    quantity: { toNumber: () => number }
    unitPriceGross: { toNumber: () => number }
    unitPriceNet: { toNumber: () => number }
    taxRate: { toNumber: () => number }
    lineNet: { toNumber: () => number }
    lineGross: { toNumber: () => number }
  },
  document: { pricesIncludeTax: boolean }
) {
  return {
    quantity: item.quantity.toNumber(),
    // Gross, as ever. The line table prints displayUnitPrice and displayAmount, on the document's price basis.
    unitPrice: item.unitPriceGross.toNumber(),
    unitPriceGross: item.unitPriceGross.toNumber(),
    unitPriceNet: item.unitPriceNet.toNumber(),
    taxRate: item.taxRate.toNumber(),
    total: item.lineGross.toNumber(),
    ...lineDisplayForUi(document, item),
  }
}

/** Quotes and the invoices converted from them share one UI shape. */
function serializeDocumentForUi<
  Document extends {
    subtotalNet: { toNumber: () => number }
    totalTax: { toNumber: () => number }
    totalGross: { toNumber: () => number }
    pricesIncludeTax: boolean
    currency: string
    items: Array<Parameters<typeof mapQuoteItemForUi>[0] & Parameters<typeof documentDisplayForUi>[0]["items"][number]>
  },
>(document: Document) {
  return {
    ...document,
    ...documentDisplayForUi(document),
    subtotal: document.subtotalNet.toNumber(),
    taxAmount: document.totalTax.toNumber(),
    total: document.totalGross.toNumber(),
    items: document.items.map((item) => ({ ...item, ...mapQuoteItemForUi(item, document) })),
  }
}

export const quotesRouter = router({
  view: authorizedProcedure("quote:read").input(z.object({ id: z.string().min(1) })).query(async ({ ctx, input }) => {
    const result = await loadDocumentView(ctx.actor, "quote", input.id)
    if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" })
    return result
  }),

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
          agreement: { select: { id: true, title: true } },
        },
      })

      return {
        ...quote,
        // A draft has no number yet. This is the number it would take if sent now; it is not reserved.
        nextNumber:
          quote.status === "draft" && quote.number === null
            ? await previewNextDocumentNumber(ctx.organizationId, "quote")
            : null,
        subtotal: quote.subtotalNet.toNumber(),
        taxAmount: quote.totalTax.toNumber(),
        total: quote.totalGross.toNumber(),
        publicViewUrl: getPublicQuoteUrl(quote),
        ...documentDisplayForUi(quote),
        items: quote.items.map((item) => ({
          ...item,
          ...mapQuoteItemForUi(item, quote),
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

  createV2: authorizedProcedure("quote:create")
    .input(quoteCreateDraftV2InputSchema)
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

  updateV2: authorizedProcedure("quote:update")
    .input(quoteUpdateDraftV2InputSchema)
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
      settleEmailResult(unwrapOutcome(await executeCommand(sendQuote, input, { actor: ctx.actor })), "quote", () =>
        prisma.quote.findUniqueOrThrow({ where: { id: input.id } })
      )
    ),

  resendEmail: authorizedProcedure("quote:send")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) =>
      settleEmailResult(unwrapOutcome(await executeCommand(resendQuoteEmail, input, { actor: ctx.actor })), "quote", () =>
        prisma.quote.findUniqueOrThrow({ where: { id: input.id } })
      )
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
