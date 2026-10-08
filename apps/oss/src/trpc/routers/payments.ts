import { z } from "zod"
import { Prisma } from "../../../generated/prisma/client"
import {
  receiptRecordInputSchema,
  receiptAllocateInputSchema,
  receiptActionInputSchema,
} from "@quits/contracts/payments"
import {
  allocateReceipt,
  changeReceipt,
  previewReceiptAllocation,
  previewReceiptChange,
  receiptBalanceFromTotals,
  recordReceipt,
} from "../../domain/commands/settlements"
import { lockArtifactOrganization } from "../../domain/documents/artifacts"
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
  receiptId?: string | null
}

export function serializePayment(payment: PaymentRow) {
  return {
    id: payment.id,
    receiptId: payment.receiptId ?? null,
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
  receipts: authorizedProcedure("payment:read")
    .input(z.object({ invoiceId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const invoice = await prisma.invoice.findFirst({
        where: { id: input.invoiceId, organizationId: ctx.organizationId },
      })
      if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" })
      const [receipts, invoices] = await Promise.all([
        prisma.settlementReceipt.findMany({
          where: { organizationId: ctx.organizationId, contactId: invoice.contactId },
          include: {
            payments: { include: { invoice: { select: { number: true } } } },
            refunds: true,
          },
          orderBy: { createdAt: "desc" },
        }),
        prisma.invoice.findMany({
          where: {
            organizationId: ctx.organizationId,
            contactId: invoice.contactId,
            status: { notIn: ["draft", "credited"] },
          },
          orderBy: { number: "asc" },
        }),
      ])
      return {
        contactId: invoice.contactId,
        canCreate: actorCan(ctx.actor, "payment:create"),
        canReverse: actorCan(ctx.actor, "payment:void"),
        invoices: invoices.map((row) => ({
          id: row.id,
          number: row.number,
          currency: row.currency,
          balanceDue: computeSettlement(row).balanceDue.toFixed(2),
        })),
        receipts: receipts.map((row) => {
          const allocated = row.payments.reduce(
            (sum, payment) => payment.voidedAt ? sum : sum.plus(payment.receiptAmount ?? 0),
            new Prisma.Decimal(0),
          )
          const refunded = row.refunds.reduce(
            (sum, refund) => refund.reversedAt ? sum : sum.plus(refund.amount),
            new Prisma.Decimal(0),
          )
          const balance = receiptBalanceFromTotals(row, allocated, refunded)
          return {
            id: row.id,
            reference: row.reference,
            currency: row.currency,
            gross: row.grossAmount.toFixed(2),
            fee: row.feeAmount.toFixed(2),
            net: row.netAmount.toFixed(2),
            available: balance.available.toFixed(2),
            allocated: balance.allocated.toFixed(2),
            refunded: balance.refunded.toFixed(2),
            reversed: Boolean(row.reversedAt),
            customerCredit: Boolean(row.creditReason) && balance.available.greaterThan(0),
            reason: row.reason,
            evidence: row.evidence,
            allocations: row.payments.map((payment) => ({
              id: payment.id,
              invoiceId: payment.invoiceId,
              invoiceNumber: payment.invoice.number ?? payment.invoiceId,
              amount: payment.amount.toFixed(2),
              currency: payment.currency,
              reversed: Boolean(payment.voidedAt),
            })),
            refunds: row.refunds.map((refund) => ({
              id: refund.id,
              amount: refund.amount.toFixed(2),
              reversed: Boolean(refund.reversedAt),
            })),
          }
        }),
      }
    }),
  recordReceipt: authorizedProcedure("payment:create")
    .input(receiptRecordInputSchema)
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(
        await executeCommand(recordReceipt, input, {
          actor: ctx.actor,
          clientRequestId: `receipt:${input.requestId}`,
        }),
      ),
    ),
  previewAllocation: authorizedProcedure("payment:create")
    .input(receiptAllocateInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await prisma.$transaction(async (db) => {
          await lockArtifactOrganization(db, ctx.organizationId)
          return previewReceiptAllocation(db, ctx.organizationId, input)
        })
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "Could not preview allocation",
        })
      }
    }),
  allocateReceipt: authorizedProcedure("payment:create")
    .input(allocateReceipt.input)
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(
        await executeCommand(allocateReceipt, input, {
          actor: ctx.actor,
          clientRequestId: `allocation:${input.requestId}`,
        }),
      ),
    ),
  previewReceiptChange: authorizedProcedure("payment:void")
    .input(receiptActionInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await prisma.$transaction(async (db) => {
          await lockArtifactOrganization(db, ctx.organizationId)
          return previewReceiptChange(db, ctx.organizationId, input)
        })
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "Could not preview change",
        })
      }
    }),
  changeReceipt: authorizedProcedure("payment:void")
    .input(changeReceipt.input)
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(
        await executeCommand(changeReceipt, input, {
          actor: ctx.actor,
          clientRequestId: `settlement:${input.requestId}`,
        }),
      ),
    ),

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
