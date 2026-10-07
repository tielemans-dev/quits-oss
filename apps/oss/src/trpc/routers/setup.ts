import { CurrencyPrecisionUnsupported } from "@quits/shared/currency"
import { TRPCError } from "@trpc/server"
import { router, setupProcedure } from "../init"
import {
  applySetupInitialization,
  completeSetup,
  getSetupStatus,
  SetupFlowError,
} from "../../lib/setup/apply"
import { setupInitializeSchema } from "../../lib/setup/validators"

function toTrpcError(error: unknown): never {
  if (error instanceof CurrencyPrecisionUnsupported) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.code, cause: error })
  }
  if (error instanceof SetupFlowError) {
    if (error.code === "SETUP_ALREADY_COMPLETE") {
      throw new TRPCError({ code: "FORBIDDEN", message: error.message })
    }
    if (error.code === "SETUP_NOT_INITIALIZED") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message })
    }
    throw new TRPCError({ code: "CONFLICT", message: error.message })
  }

  throw error
}

export const setupRouter = router({
  getStatus: setupProcedure.query(async () => {
    return getSetupStatus()
  }),

  initialize: setupProcedure
    .input(setupInitializeSchema)
    .mutation(async ({ input }) => {
      try {
        return await applySetupInitialization(input)
      } catch (error) {
        toTrpcError(error)
      }
    }),

  complete: setupProcedure.mutation(async () => {
    try {
      return await completeSetup()
    } catch (error) {
      toTrpcError(error)
    }
  }),
})
