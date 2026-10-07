import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { prisma } from "../../lib/db"
import { appLogger } from "../../lib/observability"
import {
  getPublicInvoicePaymentUrl,
} from "../../lib/payments/public"
import { getStripePaymentConfigurationState } from "../../lib/payments/stripe"
import {
  invoiceCreateDraftInputSchema,
  invoiceSendInputSchema,
  invoiceUpdateDraftInputSchema,
} from "@quits/contracts/invoices"
import {
  createInvoiceDraft,
  deleteInvoiceDraft,
  resendInvoiceEmail,
  sendInvoice,
  updateInvoiceDraft,
} from "../../domain/commands/invoices"
import { recordPayment } from "../../domain/commands/payments"
import { computeSettlement } from "../../domain/documents/settlement"
import { executeCommand } from "../../domain/execute"
import { markOrganizationInvoicesOverdue } from "../../domain/features/overdue"
import { router, authorizedProcedure } from "../init"
import { settleEmailResult } from "../email-delivery-result"
import { unwrapOutcome } from "../outcome"

const invoiceLogger = appLogger.child("invoices")

function mapInvoiceItemForUi(item: {
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

function serializeInvoiceForUi<
  Invoice extends {
    subtotalNet: { toNumber: () => number }
    totalTax: { toNumber: () => number }
    totalGross: { toNumber: () => number }
    items: Array<Parameters<typeof mapInvoiceItemForUi>[0]>
  },
>(invoice: Invoice) {
  return {
    ...invoice,
    subtotal: invoice.subtotalNet.toNumber(),
    taxAmount: invoice.totalTax.toNumber(),
    total: invoice.totalGross.toNumber(),
    items: invoice.items.map((item) => ({ ...item, ...mapInvoiceItemForUi(item) })),
  }
}

/** Paid, credited, and outstanding amounts as plain numbers for the UI. */
function settlementForUi(invoice: {
  totalGross: { toNumber: () => number }
  amountPaid: { toNumber: () => number }
  amountCredited: { toNumber: () => number }
}) {
  const settlement = computeSettlement({
    totalGross: invoice.totalGross.toNumber(),
    amountPaid: invoice.amountPaid.toNumber(),
    amountCredited: invoice.amountCredited.toNumber(),
  })
  return {
    amountPaid: settlement.amountPaid.toNumber(),
    amountCredited: settlement.amountCredited.toNumber(),
    balanceDue: settlement.balanceDue.toNumber(),
  }
}

export const invoicesRouter = router({
  list: authorizedProcedure("invoice:read")
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

      const invoices = await prisma.invoice.findMany({
        where,
        include: { contact: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      })

      return invoices.map((inv) => ({
        ...inv,
        subtotal: inv.subtotalNet.toNumber(),
        taxAmount: inv.totalTax.toNumber(),
        total: inv.totalGross.toNumber(),
        ...settlementForUi(inv),
        publicPaymentUrl: getPublicInvoicePaymentUrl(inv),
      }))
    }),

  get: authorizedProcedure("invoice:read")
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const invoice = await prisma.invoice.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          contact: true,
          items: { orderBy: { sortOrder: "asc" } },
        },
      })

      return {
        ...invoice,
        subtotal: invoice.subtotalNet.toNumber(),
        taxAmount: invoice.totalTax.toNumber(),
        total: invoice.totalGross.toNumber(),
        ...settlementForUi(invoice),
        publicPaymentUrl: getPublicInvoicePaymentUrl(invoice),
        items: invoice.items.map((item) => ({
          ...item,
          ...mapInvoiceItemForUi(item),
        })),
      }
    }),

  create: authorizedProcedure("invoice:create")
    .input(invoiceCreateDraftInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeInvoiceForUi(
        unwrapOutcome(await executeCommand(createInvoiceDraft, input, { actor: ctx.actor }))
      )
    ),

  update: authorizedProcedure("invoice:update")
    .input(invoiceUpdateDraftInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeInvoiceForUi(
        unwrapOutcome(await executeCommand(updateInvoiceDraft, input, { actor: ctx.actor }))
      )
    ),

  delete: authorizedProcedure("invoice:delete")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(deleteInvoiceDraft, input, { actor: ctx.actor }))
    ),

  send: authorizedProcedure("invoice:send")
    .input(invoiceSendInputSchema)
    .mutation(async ({ ctx, input }) =>
      settleEmailResult(unwrapOutcome(await executeCommand(sendInvoice, input, { actor: ctx.actor })), "invoice", () =>
        prisma.invoice.findUniqueOrThrow({ where: { id: input.id } })
      )
    ),

  resendEmail: authorizedProcedure("invoice:send")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) =>
      settleEmailResult(unwrapOutcome(await executeCommand(resendInvoiceEmail, input, { actor: ctx.actor })), "invoice", () =>
        prisma.invoice.findUniqueOrThrow({ where: { id: input.id } })
      )
    ),

  createPaymentLink: authorizedProcedure("invoice:send")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const invoice = await prisma.invoice.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
      })

      if (invoice.paymentStatus === "paid" || invoice.status === "paid") {
        invoiceLogger.warn("invoice.payment_link.rejected", {
          organizationId: ctx.organizationId,
          invoiceId: invoice.id,
          reason: "already_paid",
        })
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Paid invoices do not need payment links",
        })
      }

      if (invoice.status !== "sent" && invoice.status !== "overdue") {
        invoiceLogger.warn("invoice.payment_link.rejected", {
          organizationId: ctx.organizationId,
          invoiceId: invoice.id,
          reason: "invalid_status",
          status: invoice.status,
        })
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only sent or overdue invoices can create payment links",
        })
      }

      const settings = await prisma.orgSettings.findUnique({
        where: { organizationId: ctx.organizationId },
        select: {
          stripePublishableKey: true,
          stripeSecretKeyEnc: true,
          stripeWebhookSecretEnc: true,
        },
      })

      if (
        !getStripePaymentConfigurationState({
          stripePublishableKey: settings?.stripePublishableKey ?? null,
          stripeSecretKeyEnc: settings?.stripeSecretKeyEnc ?? null,
          stripeWebhookSecretEnc: settings?.stripeWebhookSecretEnc ?? null,
        }).configured
      ) {
        invoiceLogger.warn("invoice.payment_link.rejected", {
          organizationId: ctx.organizationId,
          invoiceId: invoice.id,
          reason: "stripe_not_configured",
        })
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Stripe payment links are not configured for this organization",
        })
      }

      const issuedAt = invoice.publicPaymentIssuedAt ?? new Date()
      const updated = await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          publicPaymentIssuedAt: issuedAt,
        },
      })

      const url = getPublicInvoicePaymentUrl(updated)
      if (!url) {
        invoiceLogger.error("invoice.payment_link.failed", {
          organizationId: ctx.organizationId,
          invoiceId: invoice.id,
        })
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create payment link",
        })
      }

      invoiceLogger.info("invoice.payment_link.created", {
        organizationId: ctx.organizationId,
        invoiceId: invoice.id,
        publicPaymentIssuedAt: issuedAt,
      })

      return { url }
    }),

  markOverdue: authorizedProcedure("invoice:update").mutation(async ({ ctx }) => {
    const { marked } = unwrapOutcome(
      await executeCommand(markOrganizationInvoicesOverdue, {}, { actor: ctx.actor })
    )
    return { count: marked }
  }),

  /** Shortcut that records a payment for the remaining balance through `payment.record`. */
  markPaid: authorizedProcedure("payment:create")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const invoice = await prisma.invoice.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
      })

      if (invoice.status !== "sent" && invoice.status !== "viewed" && invoice.status !== "overdue") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only sent or overdue invoices can be marked as paid",
        })
      }

      const { balanceDue } = settlementForUi(invoice)
      const result = unwrapOutcome(
        await executeCommand(
          recordPayment,
          {
            invoiceId: invoice.id,
            amount: balanceDue,
            paidAt: new Date().toISOString(),
            method: "other",
          },
          { actor: ctx.actor }
        )
      )

      return { ...result.invoice, ...settlementForUi(result.invoice) }
    }),
})
