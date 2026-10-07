import { router, authorizedProcedure } from "../init"
import { TRPCError } from "@trpc/server"
import { billingEnabled } from "../../lib/distribution"
import { billingProvider } from "../../lib/billing"

export const billingRouter = router({
  getSubscription: authorizedProcedure("settings:read").query(async ({ ctx }) => {
    if (!billingEnabled) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Billing is disabled" })
    }

    return billingProvider.getSubscription(ctx.organizationId)
  }),

  createCheckoutSession: authorizedProcedure("settings:update").mutation(async ({ ctx }) => {
    if (!billingEnabled) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Billing is disabled" })
    }

    if (!billingProvider.createCheckoutSession) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Checkout is not configured for this distribution",
      })
    }

    return billingProvider.createCheckoutSession(ctx.organizationId)
  }),

  createPortalSession: authorizedProcedure("settings:update").mutation(async ({ ctx }) => {
    if (!billingEnabled) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Billing is disabled" })
    }

    if (!billingProvider.createPortalSession) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Billing portal is not configured for this distribution",
      })
    }

    return billingProvider.createPortalSession(ctx.organizationId)
  }),
})
