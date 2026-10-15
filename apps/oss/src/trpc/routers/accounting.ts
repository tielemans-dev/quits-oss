import { actorCan } from "../../domain/actor"
import { disconnectAccounting } from "../../domain/accounting/connections"
import { readAccountingStatus } from "../../domain/accounting/status"
import { authorizedProcedure, router } from "../init"

export const accountingRouter = router({
  /** Everyone who can read settings sees the state; only those who can change settings may disconnect. */
  status: authorizedProcedure("settings:read").query(async ({ ctx }) => ({
    providers: await readAccountingStatus(ctx.organizationId),
    canDisconnect: actorCan(ctx.actor, "settings:update"),
  })),

  /** Idempotent. Pauses delivery and clears the local credential; remote revocation arrives with OAuth. */
  disconnect: authorizedProcedure("settings:update").mutation(async ({ ctx }) => {
    await disconnectAccounting(ctx.organizationId)
    return { providers: await readAccountingStatus(ctx.organizationId), canDisconnect: true }
  }),
})
