import { actorCan } from "../../domain/actor"
import { disconnectAccountingCommand, retryAccountingDelivery, skipAccountingDelivery, retryAccountingInput, skipAccountingInput } from "../../domain/commands/accounting"
import { executeCommand } from "../../domain/execute"
import { unwrapOutcome } from "../outcome"
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
    unwrapOutcome(await executeCommand(disconnectAccountingCommand, {}, { actor: ctx.actor }))
    return { providers: await readAccountingStatus(ctx.organizationId), canDisconnect: true }
  }),
  retry: authorizedProcedure("settings:update").input(retryAccountingInput).mutation(async ({ ctx, input }) => {
    unwrapOutcome(await executeCommand(retryAccountingDelivery, input, { actor: ctx.actor }))
    return { providers: await readAccountingStatus(ctx.organizationId), canDisconnect: true }
  }),
  skip: authorizedProcedure("settings:update").input(skipAccountingInput).mutation(async ({ ctx, input }) => {
    unwrapOutcome(await executeCommand(skipAccountingDelivery, input, { actor: ctx.actor }))
    return { providers: await readAccountingStatus(ctx.organizationId), canDisconnect: true }
  }),
})
