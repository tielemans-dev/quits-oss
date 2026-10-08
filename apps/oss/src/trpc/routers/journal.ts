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
import { Forbidden, InvalidState, NotFound, serializeDomainError } from "../../domain/errors"
import { orgProcedure, router } from "../init"
import { DomainRefusal, unwrapOutcome } from "../outcome"

async function translate<Value>(work: () => Promise<Value>, message: string) {
  try {
    return await work()
  } catch (error) {
    if (error instanceof Forbidden || error instanceof NotFound || error instanceof InvalidState) {
      throw new TRPCError({
        code: error instanceof Forbidden ? "FORBIDDEN"
          : error instanceof NotFound ? "NOT_FOUND" : "PRECONDITION_FAILED",
        message: error.message,
        cause: new DomainRefusal(serializeDomainError(error))
      })
    }
    // Persistence/provider errors can contain private details, including in a TRPCError.
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message })
  }
}

export const journalRouter = router({
  forDocument: orgProcedure
    .input(journalDocumentInputSchema)
    .query(({ ctx, input }) =>
      translate(() => documentJournal(ctx.actor, input), "Could not load operation history")
    ),
  recover: orgProcedure
    .input(journalDeliveryInputSchema)
    .mutation(({ ctx, input }) =>
      translate(() => recoverDelivery(ctx.actor, input), "Could not recover delivery")
    ),
  reconcile: orgProcedure
    .input(journalDeliveryInputSchema)
    .mutation(({ ctx, input }) =>
      translate(() => reconcileDelivery(ctx.actor, input), "Could not reconcile delivery")
    ),
  manualResend: orgProcedure
    .input(journalManualResendInputSchema)
    .mutation(async ({ ctx, input }) => {
      // Only returned command outcomes are trusted. A rejected executor promise is unexpected.
      const outcome = await executeCommand(manualResendCommand(input.documentType), input, {
        actor: ctx.actor,
        clientRequestId: input.clientRequestId
      }).catch(() => {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not resend document" })
      })
      unwrapOutcome(outcome)
      return translate(() => documentJournal(ctx.actor, input), "Could not load operation history")
    })
})
