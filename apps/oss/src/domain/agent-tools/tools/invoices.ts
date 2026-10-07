import { recordBaseValuation, recordBaseValuationInputSchema } from "../../commands/base-valuation"
import { createInvoiceFromDeliverables, addInvoiceDeliverables } from "../../commands/invoices-from-deliverables"
import { invoiceCreateFromDeliverablesInputSchema, invoiceAddDeliverablesInputSchema } from "@quits/contracts/invoices"
import {
  invoiceCreateDraftV2InputSchema,
  invoiceIdInputSchema,
  invoiceSendInputSchema,
  invoiceUpdateDraftV2InputSchema,
} from "@quits/contracts/invoices"
import { documentIdToolInputSchema, invoicesListToolInputSchema } from "@quits/contracts/agent"
import { prisma } from "../../../lib/db"
import {
  createInvoiceDraft,
  resendInvoiceEmail,
  sendInvoice,
  updateInvoiceDraft,
} from "../../commands/invoices"
import { NotFound } from "../../errors"
import { defineCommandTool, defineQueryTool, type AgentTool } from "../define"
import { afterNewest, decodeCursor, toPage } from "../pagination"
import { presentInvoice, type InvoiceRow } from "./documents"

const presentSent = (
  result: InvoiceRow & { emailSent: boolean; emailPending?: boolean; emailSkipReason?: string }
) => ({
  ...presentInvoice(result),
  emailSent: result.emailSent,
  // Queued emails are delivered right after the command; invoices_get shows the outcome.
  emailPending: result.emailPending ?? false,
  emailSkipReason: result.emailSkipReason ?? null,
})

export const invoiceTools: AgentTool[] = [
  defineCommandTool({ name: "invoice_record_base_valuation", title: "Record reviewed historical valuation", description: "Human review only. Records a historical base rate with an evidence note. Agents receive human_review_required.", command: recordBaseValuation, input: recordBaseValuationInputSchema, present: presentInvoice }),

  defineCommandTool({ name: "invoice_create_from_deliverables", title: "Invoice deliverables",
    description: "Reserves billable deliverables and creates drafts atomically. Returns { saleInvoiceId?, prepaymentInvoiceId? }. Schedule lines create prepayment drafts whose issuance is not supported yet. Set scheduleAsSale only on explicit instruction to invoice schedule lines as sales; that choice is recorded. Nothing is sent.",
    command: createInvoiceFromDeliverables, input: invoiceCreateFromDeliverablesInputSchema }),
  defineCommandTool({ name: "invoice_add_deliverables", title: "Add deliverables to invoice",
    description: "Reserves billable work on a draft linked to the same agreement. The draft purpose must match; scheduleAsSale records an explicit sale choice. Nothing is sent.",
    command: addInvoiceDeliverables, input: invoiceAddDeliverablesInputSchema, present: presentInvoice }),

  defineQueryTool({
    name: "invoices_list",
    title: "List invoices",
    description:
      "Lists invoices, newest first, with totals, amount paid, amount credited, and balanceDue. " +
      "Filter by status, paymentStatus, or contactId. Returns { items, nextCursor }; pass nextCursor " +
      "to get the next page.",
    input: invoicesListToolInputSchema,
    permission: "invoice:read",
    run: async ({ actor }, input) => {
      const invoices = await prisma.invoice.findMany({
        where: {
          organizationId: actor.organizationId,
          ...(input.status ? { status: input.status } : {}),
          ...(input.paymentStatus ? { paymentStatus: input.paymentStatus } : {}),
          ...(input.contactId ? { contactId: input.contactId } : {}),
          ...afterNewest(decodeCursor(input.cursor)),
        },
        include: { contact: { select: { id: true, name: true, email: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
      })
      const page = toPage(invoices, input.limit, (invoice) => invoice.createdAt.toISOString())
      return { items: page.items.map(presentInvoice), nextCursor: page.nextCursor }
    },
  }),

  defineQueryTool({
    name: "invoice_get",
    title: "Get invoice",
    description: "Returns one invoice with its line items, customer, balance, and public payment link.",
    input: documentIdToolInputSchema,
    permission: "invoice:read",
    run: async ({ actor }, input) => {
      const invoice = await prisma.invoice.findFirst({
        where: { id: input.id, organizationId: actor.organizationId },
        include: {
          contact: { select: { id: true, name: true, email: true } },
          items: { orderBy: { sortOrder: "asc" } },
        },
      })
      if (!invoice) {
        throw new NotFound({ message: "Invoice not found", entity: "invoice", id: input.id })
      }
      return presentInvoice(invoice)
    },
  }),

  defineCommandTool({
    name: "invoice_create_draft",
    title: "Create draft invoice",
    description:
      "Creates a draft invoice for a contact. Drafts are free: nothing is sent and no approval is " +
      "needed. unitPrice follows the organization's pricesIncludeTax setting (see organization_read); " +
      "taxRate is a percentage. dueDate is YYYY-MM-DD.",
    command: createInvoiceDraft,
    input: invoiceCreateDraftV2InputSchema,
    present: presentInvoice,
  }),

  defineCommandTool({
    name: "invoice_update_draft",
    title: "Update draft invoice",
    description:
      "Edits a draft invoice. Passing items replaces all line items. Only drafts can be edited.",
    command: updateInvoiceDraft,
    input: invoiceUpdateDraftV2InputSchema,
    present: presentInvoice,
  }),

  defineCommandTool({
    name: "invoice_send",
    title: "Send invoice",
    description:
      "Issues a draft invoice and emails it to the contact's email address. The invoice gets an " +
      "issue date and can no longer be edited. A disputed draft requires acknowledgeDisputed: true, recorded in activity. Set allowSendWithoutEmail only when the person asked " +
      "to mark it sent even though email delivery is not configured. The invoice becomes sent once the " +
      "email provider accepts the email; if the result has emailPending: true, check invoices_get " +
      "(lastEmailAttempt) for the outcome instead of sending again.",
    command: sendInvoice,
    input: invoiceSendInputSchema,
    present: presentSent,
  }),

  defineCommandTool({
    name: "invoice_resend_email",
    title: "Resend invoice email",
    description: "Emails a sent or overdue invoice to the contact again, e.g. as a manual reminder.",
    command: resendInvoiceEmail,
    input: invoiceIdInputSchema,
    present: presentSent,
  }),
]
