import { isCloudDistribution } from "../../lib/distribution"
import { paymentDetailsInputSchema, type PaymentDetailsState } from "@quits/contracts/payment-details"
import { actorCan } from "../../domain/actor"
import { updatePaymentDetails } from "../../domain/commands/payment-details"
import { executeCommand } from "../../domain/execute"
import { prisma } from "../../lib/db"
import { paymentDetailsFromColumns, paymentDetailsSelect } from "../../lib/payment-details"
import { authorizedProcedure, router } from "../init"
import { unwrapOutcome } from "../outcome"
import { previewNextDocumentNumber } from "../../domain/documents/number-preview"
import { resolveInvoiceEmailContext } from "../../domain/documents/invoice-email"

/**
 * The bank account and payment note printed on invoices. Reading needs the same right as reading
 * settings, and changing them needs the right to update settings. Invoices already issued keep
 * the details they were issued with: those are frozen onto the invoice, so a change here only
 * affects later ones. Every change is recorded in the audit log and sent to the admins.
 */
export const paymentDetailsRouter = router({
  firstSendReadiness: authorizedProcedure("invoice:send").query(async ({ ctx }) => {
    if (!isCloudDistribution) return { bankMissing: false }
    const settings = await prisma.orgSettings.findUnique({ where: { organizationId: ctx.organizationId } })
    if (settings?.onboardingVersion !== 2 || paymentDetailsFromColumns(settings).bankAccount) return { bankMissing: false }
    const issued = await prisma.invoice.count({ where: { organizationId: ctx.organizationId, number: { not: null } } })
    if (issued > 0) return { bankMissing: false }
    // Card payments are another way to get paid, so sending without an account only warns when there are none.
    return { bankMissing: true, onlinePayments: resolveInvoiceEmailContext(settings).stripeConfigured, canSave: actorCan(ctx.actor, "settings:update") }
  }),
  get: authorizedProcedure("settings:read").query(async ({ ctx }): Promise<PaymentDetailsState & { nextInvoiceNumber: string }> => {
    const settings = await prisma.orgSettings.findUnique({
      where: { organizationId: ctx.organizationId },
      select: paymentDetailsSelect,
    })
    return {
      ...paymentDetailsFromColumns(settings),
      canUpdate: actorCan(ctx.actor, "settings:update"),
      nextInvoiceNumber: await previewNextDocumentNumber(ctx.organizationId, "invoice"),
    }
  }),

  /** Replaces all payment details; a part left out or blank is cleared, and no account clears the account. */
  update: authorizedProcedure("settings:update")
    .input(paymentDetailsInputSchema)
    .mutation(async ({ ctx, input }): Promise<PaymentDetailsState> => {
      const details = unwrapOutcome(await executeCommand(updatePaymentDetails, input, { actor: ctx.actor }))
      return { ...details, canUpdate: true }
    }),
})
