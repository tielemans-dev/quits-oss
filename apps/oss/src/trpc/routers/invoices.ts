import { loadDocumentView } from "../../domain/documents/view"
import { sanitizeDocumentEmailAttempt } from "../../domain/delivery/provider-failure"
import { recordBaseValuation } from "../../domain/commands/base-valuation"
import { randomUUID } from "node:crypto"
import { createInvoiceFromDeliverables, addInvoiceDeliverables, invoiceScheduleAsSale } from "../../domain/commands/invoices-from-deliverables"
import { invoiceCreateFromDeliverablesInputSchema, invoiceAddDeliverablesInputSchema } from "@quits/contracts/invoices"
import { executeIssuanceCommand } from "../../application/issuance"
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
  invoiceCreateDraftV2InputSchema,
  invoiceSendInputSchema,
  invoiceUpdateDraftInputSchema,
  invoiceUpdateDraftV2InputSchema,
} from "@quits/contracts/invoices"
import {
  createInvoiceDraft,
  deleteInvoiceDraft,
  resendInvoiceEmail,
  sendInvoice,
  updateInvoiceDraft,
} from "../../domain/commands/invoices"
import { markInvoicePaid, undoInvoiceMarkPaid } from "../../domain/commands/paid-moment"
import { invoicePaidMomentResultSchema } from "@quits/contracts/invoices"
import { previewNextDocumentNumber } from "../../domain/documents/number-preview"
import { computeSettlement } from "../../domain/documents/settlement"
import { executeCommand } from "../../domain/execute"
import { markOrganizationInvoicesOverdue } from "../../domain/features/overdue"
import { router, authorizedProcedure } from "../init"
import { documentDisplayForUi, lineDisplayForUi } from "./document-display"
import { settleEmailResult } from "../email-delivery-result"
import { unwrapOutcome } from "../outcome"

const invoiceLogger = appLogger.child("invoices")

function mapInvoiceItemForUi(
  item: {
    quantity: { toNumber: () => number }
    unitPriceGross: { toNumber: () => number }
    unitPriceNet: { toNumber: () => number }
    taxRate: { toNumber: () => number }
    lineNet: { toNumber: () => number }
    lineGross: { toNumber: () => number }
  },
  invoice: { pricesIncludeTax: boolean }
) {
  return {
    quantity: item.quantity.toNumber(),
    // Gross, as ever. The line table prints displayUnitPrice and displayAmount, on the invoice's price basis.
    unitPrice: item.unitPriceGross.toNumber(),
    unitPriceGross: item.unitPriceGross.toNumber(),
    unitPriceNet: item.unitPriceNet.toNumber(),
    taxRate: item.taxRate.toNumber(),
    total: item.lineGross.toNumber(),
    ...lineDisplayForUi(invoice, item),
  }
}

function serializeInvoiceForUi<
  Invoice extends {
    subtotalNet: { toNumber: () => number }
    totalTax: { toNumber: () => number }
    totalGross: { toNumber: () => number }
    pricesIncludeTax: boolean
    currency: string
    items: Array<Parameters<typeof mapInvoiceItemForUi>[0] & Parameters<typeof documentDisplayForUi>[0]["items"][number]>
  },
>(invoice: Invoice) {
  return {
    ...sanitizeDocumentEmailAttempt(invoice),
    ...documentDisplayForUi(invoice),
    subtotal: invoice.subtotalNet.toNumber(),
    taxAmount: invoice.totalTax.toNumber(),
    total: invoice.totalGross.toNumber(),
    items: invoice.items.map((item) => ({ ...item, ...mapInvoiceItemForUi(item, invoice) })),
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
  view: authorizedProcedure("invoice:read").input(z.object({ id: z.string().min(1) })).query(async ({ ctx, input }) => {
    const result = await loadDocumentView(ctx.actor, "invoice", input.id)
    if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" })
    return result
  }),

  recordBaseValuation: authorizedProcedure("invoice:update").input(recordBaseValuation.input).mutation(async ({ ctx, input }) => unwrapOutcome(await executeCommand(recordBaseValuation, input, { actor: ctx.actor }))),
  createFromDeliverables: authorizedProcedure("invoice:create").input(invoiceCreateFromDeliverablesInputSchema).mutation(async ({ ctx, input }) => unwrapOutcome(await executeCommand(createInvoiceFromDeliverables, input, { actor: ctx.actor, clientRequestId: randomUUID() }))),
  addDeliverables: authorizedProcedure("invoice:update").input(invoiceAddDeliverablesInputSchema).mutation(async ({ ctx, input }) => serializeInvoiceForUi(unwrapOutcome(await executeCommand(addInvoiceDeliverables, input, { actor: ctx.actor })))),
  scheduleAsSale: authorizedProcedure("invoice:update").input(invoiceScheduleAsSale.input).mutation(async ({ ctx, input }) => serializeInvoiceForUi(unwrapOutcome(await executeCommand(invoiceScheduleAsSale, input, { actor: ctx.actor })))),

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

      // The response keeps every invoice column: external tRPC callers may read any of them.
      const invoices = await prisma.invoice.findMany({
        where,
        include: { contact: { select: { name: true } } },
        // id breaks createdAt ties so the order is stable; invoice(organizationId, createdAt, id) serves it.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      })

      return invoices.map((inv) => ({
        ...sanitizeDocumentEmailAttempt(inv),
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
          agreement: { select: { taxRateInput: true, taxRate: true } },
          items: { orderBy: { sortOrder: "asc" } },
        },
      })

      return {
        ...sanitizeDocumentEmailAttempt(invoice),
        // A draft has no number yet. This is the number it would take if sent now; it is not reserved.
        nextNumber:
          invoice.status === "draft" && invoice.number === null
            ? await previewNextDocumentNumber(ctx.organizationId, "invoice")
            : null,
        agreementTaxRate: invoice.agreement?.taxRateInput ?? invoice.agreement?.taxRate.toString() ?? null,
        subtotal: invoice.subtotalNet.toNumber(),
        taxAmount: invoice.totalTax.toNumber(),
        total: invoice.totalGross.toNumber(),
        ...settlementForUi(invoice),
        publicPaymentUrl: getPublicInvoicePaymentUrl(invoice),
        ...documentDisplayForUi(invoice),
        items: invoice.items.map((item) => ({
          ...item,
          ...mapInvoiceItemForUi(item, invoice),
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

  createV2: authorizedProcedure("invoice:create")
    .input(invoiceCreateDraftV2InputSchema)
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

  updateV2: authorizedProcedure("invoice:update")
    .input(invoiceUpdateDraftV2InputSchema)
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
      settleEmailResult(unwrapOutcome(await executeIssuanceCommand(sendInvoice, input, { actor: ctx.actor })), "invoice", () =>
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

  markPaid: authorizedProcedure("payment:create")
    .input(markInvoicePaid.input)
    .output(invoicePaidMomentResultSchema)
    .mutation(async ({ ctx, input }) => unwrapOutcome(await executeCommand(markInvoicePaid, input, {
      actor: ctx.actor, clientRequestId: `invoice.mark_paid:${input.invoiceId}:${input.requestId}`,
    }))),

  undoMarkPaid: authorizedProcedure("payment:void")
    .input(undoInvoiceMarkPaid.input)
    .output(invoicePaidMomentResultSchema)
    .mutation(async ({ ctx, input }) => unwrapOutcome(await executeCommand(undoInvoiceMarkPaid, input, {
      actor: ctx.actor, clientRequestId: `invoice.undo_mark_paid:${input.invoiceId}:${input.paymentId}:${input.requestId}`,
    }))),
})
