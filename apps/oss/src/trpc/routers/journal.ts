import { TRPCError } from "@trpc/server"
import {
  journalDeliveryInputSchema,
  journalDocumentInputSchema,
  journalManualResendInputSchema
} from "@quits/contracts/journal"
import {
  documentJournal,
  manualResendCommand,
  reconcileDelivery,
  recoverDelivery
} from "../../domain/delivery/journal"
import { executeCommand } from "../../domain/execute"
import { Forbidden, InvalidState, NotFound } from "../../domain/errors"
import { orgProcedure, router } from "../init"
import { unwrapOutcome } from "../outcome"

async function translate<Value>(work: () => Promise<Value>) {
  try {
    return await work()
  } catch (error) {
    if (error instanceof Forbidden)
      throw new TRPCError({ code: "FORBIDDEN", message: error.message })
    if (error instanceof NotFound)
      throw new TRPCError({ code: "NOT_FOUND", message: error.message })
    if (error instanceof InvalidState)
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: error.message
      })
    throw error
  }
}

export const journalRouter = router({
  forDocument: orgProcedure
    .input(journalDocumentInputSchema)
    .query(({ ctx, input }) =>
      translate(() => documentJournal(ctx.actor, input))
    ),
  recover: orgProcedure
    .input(journalDeliveryInputSchema)
    .mutation(({ ctx, input }) =>
      translate(() => recoverDelivery(ctx.actor, input))
    ),
  reconcile: orgProcedure
    .input(journalDeliveryInputSchema)
    .mutation(({ ctx, input }) =>
      translate(() => reconcileDelivery(ctx.actor, input))
    ),
  manualResend: orgProcedure
    .input(journalManualResendInputSchema)
    .mutation(({ ctx, input }) =>
      translate(async () => {
        unwrapOutcome(
          await executeCommand(manualResendCommand(input.documentType), input, {
            actor: ctx.actor,
            clientRequestId: input.clientRequestId
          })
        )
        return documentJournal(ctx.actor, input)
      })
    )
})
