import { paymentListInputSchema, paymentRecordInputSchema, paymentVoidInputSchema } from "@yaip/contracts/payments"
import { prisma } from "../../../lib/db"
import { recordPayment, voidPayment } from "../../commands/payments"
import { computeSettlement } from "../../documents/settlement"
import { NotFound } from "../../errors"
import { defineCommandTool, defineQueryTool, type AgentTool } from "../define"

export const paymentTools: AgentTool[] = [
  defineQueryTool({
    name: "payments_list",
    title: "List payments for an invoice",
    description:
      "Returns the payments recorded against an invoice (including voided ones) and its balanceDue. " +
      "Check this before recording a payment so you do not record the same payment twice.",
    input: paymentListInputSchema,
    permission: "payment:read",
    run: async ({ actor }, input) => {
      const invoice = await prisma.invoice.findFirst({
        where: { id: input.invoiceId, organizationId: actor.organizationId },
        include: { payments: { orderBy: { paidAt: "asc" } } },
      })
      if (!invoice) {
        throw new NotFound({ message: "Invoice not found", entity: "invoice", id: input.invoiceId })
      }
      const settlement = computeSettlement(invoice)
      return {
        invoiceId: invoice.id,
        number: invoice.number,
        currency: invoice.currency,
        paymentStatus: settlement.paymentStatus,
        balanceDue: settlement.balanceDue.toNumber(),
        payments: invoice.payments.map((payment) => ({
          id: payment.id,
          amount: payment.amount.toNumber(),
          paidAt: payment.paidAt.toISOString(),
          method: payment.method,
          reference: payment.reference,
          note: payment.note,
          source: payment.source,
          voidedAt: payment.voidedAt?.toISOString() ?? null,
          voidReason: payment.voidReason,
        })),
      }
    },
  }),

  defineCommandTool({
    name: "payment_record",
    title: "Record payment",
    description:
      "Records money received against an issued invoice, e.g. a bank transfer you found in a " +
      "statement. amount is in the invoice currency and cannot exceed balanceDue; paidAt is " +
      "YYYY-MM-DD (the organization's calendar day). The invoice becomes paid when the balance reaches 0.",
    command: recordPayment,
    input: paymentRecordInputSchema,
  }),

  defineCommandTool({
    name: "payment_void",
    title: "Void payment",
    description:
      "Voids a payment that was recorded by mistake, with a reason. A paid invoice reopens. Payments " +
      "are never deleted; the voided record stays in the history.",
    command: voidPayment,
    input: paymentVoidInputSchema,
  }),
]
