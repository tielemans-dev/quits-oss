import {
  quoteCreateDraftInputSchema,
  quoteIdInputSchema,
  quoteSendInputSchema,
  quoteUpdateDraftInputSchema,
} from "@yaip/contracts/quotes"
import { documentIdToolInputSchema, quotesListToolInputSchema } from "@yaip/contracts/agent"
import { prisma } from "../../../lib/db"
import {
  convertQuoteToInvoice,
  createQuoteDraft,
  resendQuoteEmail,
  sendQuote,
  updateQuoteDraft,
} from "../../commands/quotes"
import { NotFound } from "../../errors"
import { defineCommandTool, defineQueryTool, type AgentTool } from "../define"
import { afterNewest, decodeCursor, toPage } from "../pagination"
import { presentInvoice, presentQuote } from "./documents"

export const quoteTools: AgentTool[] = [
  defineQueryTool({
    name: "quotes_list",
    title: "List quotes",
    description:
      "Lists quotes (estimates), newest first. Filter by status or contactId. Returns " +
      "{ items, nextCursor }; pass nextCursor to get the next page.",
    input: quotesListToolInputSchema,
    permission: "quote:read",
    run: async ({ actor }, input) => {
      const quotes = await prisma.quote.findMany({
        where: {
          organizationId: actor.organizationId,
          ...(input.status ? { status: input.status } : {}),
          ...(input.contactId ? { contactId: input.contactId } : {}),
          ...afterNewest(decodeCursor(input.cursor)),
        },
        include: { contact: { select: { id: true, name: true, email: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
      })
      const page = toPage(quotes, input.limit, (quote) => quote.createdAt.toISOString())
      return { items: page.items.map(presentQuote), nextCursor: page.nextCursor }
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

  defineCommandTool({
    name: "quote_create_draft",
    title: "Create draft quote",
    description:
      "Creates a draft quote (estimate) for a contact. Drafts are free: nothing is sent and no " +
      "approval is needed. expiryDate is YYYY-MM-DD; taxRate is a percentage.",
    command: createQuoteDraft,
    input: quoteCreateDraftInputSchema,
    present: presentQuote,
  }),

  defineCommandTool({
    name: "quote_update_draft",
    title: "Update draft quote",
    description: "Edits a draft quote. Passing items replaces all line items. Only drafts can be edited.",
    command: updateQuoteDraft,
    input: quoteUpdateDraftInputSchema,
    present: presentQuote,
  }),

  defineCommandTool({
    name: "quote_send",
    title: "Send quote",
    description:
      "Emails a draft quote to the contact with a link where they can accept or reject it. The quote " +
      "can no longer be edited afterwards.",
    command: sendQuote,
    input: quoteSendInputSchema,
    present: presentQuote,
  }),

  defineCommandTool({
    name: "quote_resend_email",
    title: "Resend quote email",
    description: "Emails a sent quote to the contact again.",
    command: resendQuoteEmail,
    input: quoteIdInputSchema,
    present: presentQuote,
  }),

  defineCommandTool({
    name: "quote_convert_to_invoice",
    title: "Convert quote to invoice",
    description:
      "Creates a draft invoice from a quote the customer accepted. The invoice is a draft; send it " +
      "with invoice_send.",
    command: convertQuoteToInvoice,
    input: quoteIdInputSchema,
    present: presentInvoice,
  }),
]
