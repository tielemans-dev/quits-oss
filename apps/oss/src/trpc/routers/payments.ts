import { TRPCError } from "@trpc/server"
import {
  paymentListInputSchema,
  paymentRecordInputSchema,
  paymentVoidInputSchema,
} from "@quits/contracts/payments"
import { actorCan } from "../../domain/actor"
import { recordPayment, voidPayment } from "../../domain/commands/payments"
import { computeSettlement } from "../../domain/documents/settlement"
import { executeCommand } from "../../domain/execute"
import { prisma } from "../../lib/db"
import { authorizedProcedure, router } from "../init"
import { unwrapOutcome } from "../outcome"

type PaymentRow = {
  id: string
  invoiceId: string
  amount: { toNumber(): number }
  currency: string
  paidAt: Date
  method: string
  reference: string | null
  note: string | null
  source: string
  voidedAt: Date | null
  voidReason: string | null
  createdAt: Date
}

export function serializePayment(payment: PaymentRow) {
  return {
    id: payment.id,
    invoiceId: payment.invoiceId,
    amount: payment.amount.toNumber(),
    currency: payment.currency,
    paidAt: payment.paidAt,
    method: payment.method,
    reference: payment.reference,
    note: payment.note,
    source: payment.source,
    voidedAt: payment.voidedAt,
    voidReason: payment.voidReason,
    createdAt: payment.createdAt,
  }
}

/** Owned by the payments feature. */
export const paymentsRouter = router({
  list: authorizedProcedure("payment:read")
    .input(paymentListInputSchema)
    .query(async ({ ctx, input }) => {
      const invoice = await prisma.invoice.findFirst({
        where: { id: input.invoiceId, organizationId: ctx.organizationId },
        select: {
          id: true,
          status: true,
          currency: true,
          totalGross: true,
          amountPaid: true,
          amountCredited: true,
          paymentStatus: true,
          payments: { orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }] },
        },
      })
      if (!invoice) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" })
      }

      const settings = await prisma.orgSettings.findUnique({
        where: { organizationId: ctx.organizationId },
        select: { timezone: true },
      })

      const settlement = computeSettlement(invoice)
      return {
        /** Calendar payment dates are stored as the start of that day in this time zone. */
        timeZone: settings?.timezone ?? "UTC",
        payments: invoice.payments.map(serializePayment),
        currency: invoice.currency,
        total: settlement.totalGross.toNumber(),
        amountPaid: settlement.amountPaid.toNumber(),
        amountCredited: settlement.amountCredited.toNumber(),
        balanceDue: settlement.balanceDue.toNumber(),
        paymentStatus: invoice.paymentStatus,
        canRecord:
          actorCan(ctx.actor, "payment:create") &&
          invoice.status !== "draft" &&
          invoice.status !== "credited" &&
          settlement.balanceDue.greaterThan(0),
        canVoid: actorCan(ctx.actor, "payment:void"),
      }
    }),

  record: authorizedProcedure("payment:create")
    .input(paymentRecordInputSchema)
    .mutation(async ({ ctx, input }) => {
      const result = unwrapOutcome(await executeCommand(recordPayment, input, { actor: ctx.actor }))
      return { payment: serializePayment(result.payment), balanceDue: result.balanceDue.toNumber() }
    }),

  void: authorizedProcedure("payment:void")
    .input(paymentVoidInputSchema)
    .mutation(async ({ ctx, input }) => {
      const result = unwrapOutcome(await executeCommand(voidPayment, input, { actor: ctx.actor }))
      return { payment: serializePayment(result.payment), balanceDue: result.balanceDue.toNumber() }
    }),
})
