import { paymentDetailsInputSchema, type PaymentDetailsState } from "@quits/contracts/payment-details"
import { actorCan } from "../../domain/actor"
import { prisma } from "../../lib/db"
import {
  paymentDetailsFromColumns,
  paymentDetailsSelect,
  paymentDetailsToColumns,
} from "../../lib/payment-details"
import { authorizedProcedure, router } from "../init"

/**
 * The bank details printed on invoices. Reading needs the same right as reading settings, and
 * changing them needs the right to update settings. Invoices already issued keep the details they
 * were issued with: those are frozen onto the invoice, so a change here only affects later ones.
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

  /** Replaces all payment details; a field left out or blank is cleared, and no account clears the account. */
  update: authorizedProcedure("settings:update")
    .input(paymentDetailsInputSchema)
    .mutation(async ({ ctx, input }): Promise<PaymentDetailsState> => {
      const columns = paymentDetailsToColumns(input)
      const settings = await prisma.orgSettings.upsert({
        where: { organizationId: ctx.organizationId },
        update: columns,
        create: { organizationId: ctx.organizationId, ...columns },
        select: paymentDetailsSelect,
      })
      return { ...paymentDetailsFromColumns(settings), canUpdate: true }
    }),
})
