import {
  invoiceCreateDraftInputSchema,
  invoiceIdInputSchema,
  invoiceSendInputSchema,
  invoiceUpdateDraftInputSchema,
} from "@yaip/contracts/invoices"
import { documentIdToolInputSchema, invoicesListToolInputSchema } from "@yaip/contracts/agent"
import { prisma } from "../../../lib/db"
import {
  createInvoiceDraft,
  resendInvoiceEmail,
  sendInvoice,
  updateInvoiceDraft,
} from "../../commands/invoices"
import { NotFound } from "../../errors"
import { defineCommandTool, defineQueryTool, type AgentTool } from "../define"
import { presentInvoice, type InvoiceRow } from "./documents"

const presentSent = (result: InvoiceRow & { emailSent: boolean; emailSkipReason?: string }) => ({
  ...presentInvoice(result),
  emailSent: result.emailSent,
  emailSkipReason: result.emailSkipReason ?? null,
})

export const invoiceTools: AgentTool[] = [
  defineQueryTool({
    name: "invoices_list",
    title: "List invoices",
    description:
      "Lists invoices, newest first, with totals, amount paid, amount credited, and balanceDue. " +
      "Filter by status, paymentStatus, or contactId.",
    input: invoicesListToolInputSchema,
    permission: "invoice:read",
    run: async ({ actor }, input) => {
      const invoices = await prisma.invoice.findMany({
        where: {
          organizationId: actor.organizationId,
          ...(input.status ? { status: input.status } : {}),
          ...(input.paymentStatus ? { paymentStatus: input.paymentStatus } : {}),
          ...(input.contactId ? { contactId: input.contactId } : {}),
        },
        include: { contact: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "desc" },
        take: input.limit,
      })
      return invoices.map(presentInvoice)
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
    input: invoiceCreateDraftInputSchema,
    present: presentInvoice,
  }),

  defineCommandTool({
    name: "invoice_update_draft",
    title: "Update draft invoice",
    description:
      "Edits a draft invoice. Passing items replaces all line items. Only drafts can be edited.",
    command: updateInvoiceDraft,
    input: invoiceUpdateDraftInputSchema,
    present: presentInvoice,
  }),

  defineCommandTool({
    name: "invoice_send",
    title: "Send invoice",
    description:
      "Issues a draft invoice and emails it to the contact's email address. The invoice gets an " +
      "issue date and can no longer be edited. Set allowSendWithoutEmail only when the person asked " +
      "to mark it sent even though email delivery is not configured.",
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
