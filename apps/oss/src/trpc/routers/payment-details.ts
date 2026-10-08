import { paymentDetailsInputSchema, type PaymentDetailsState } from "@quits/contracts/payment-details"
import { actorCan } from "../../domain/actor"
import { updatePaymentDetails } from "../../domain/commands/payment-details"
import { executeCommand } from "../../domain/execute"
import { prisma } from "../../lib/db"
import { paymentDetailsFromColumns, paymentDetailsSelect } from "../../lib/payment-details"
import { authorizedProcedure, router } from "../init"
import { unwrapOutcome } from "../outcome"

/**
 * The bank account and payment note printed on invoices. Reading needs the same right as reading
 * settings, and changing them needs the right to update settings. Invoices already issued keep
 * the details they were issued with: those are frozen onto the invoice, so a change here only
 * affects later ones. Every change is recorded in the audit log and sent to the admins.
 */
export const paymentDetailsRouter = router({
  get: authorizedProcedure("settings:read").query(async ({ ctx }): Promise<PaymentDetailsState> => {
    const settings = await prisma.orgSettings.findUnique({
      where: { organizationId: ctx.organizationId },
      select: paymentDetailsSelect,
    })
    return {
      ...paymentDetailsFromColumns(settings),
      canUpdate: actorCan(ctx.actor, "settings:update"),
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
