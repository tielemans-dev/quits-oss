import { documentIdToolInputSchema, quotesListToolInputSchema } from "@yaip/contracts/agent"
import { prisma } from "../../../lib/db"
import { NotFound } from "../../errors"
import { defineQueryTool, type AgentTool } from "../define"
import { presentQuote } from "./documents"

export const quoteTools: AgentTool[] = [
  defineQueryTool({
    name: "quotes_list",
    title: "List quotes",
    description: "Lists quotes (estimates), newest first. Filter by status or contactId.",
    input: quotesListToolInputSchema,
    permission: "quote:read",
    run: async ({ actor }, input) => {
      const quotes = await prisma.quote.findMany({
        where: {
          organizationId: actor.organizationId,
          ...(input.status ? { status: input.status } : {}),
          ...(input.contactId ? { contactId: input.contactId } : {}),
        },
        include: { contact: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "desc" },
        take: input.limit,
      })
      return quotes.map(presentQuote)
    },
  }),

  defineQueryTool({
    name: "quote_get",
    title: "Get quote",
    description: "Returns one quote with line items, customer, decision, and invoices created from it.",
    input: documentIdToolInputSchema,
    permission: "quote:read",
    run: async ({ actor }, input) => {
      const quote = await prisma.quote.findFirst({
        where: { id: input.id, organizationId: actor.organizationId },
        include: {
          contact: { select: { id: true, name: true, email: true } },
          items: { orderBy: { sortOrder: "asc" } },
          invoices: { select: { id: true, number: true } },
        },
      })
      if (!quote) {
        throw new NotFound({ message: "Quote not found", entity: "quote", id: input.id })
      }
      return presentQuote(quote)
    },
  }),
]
