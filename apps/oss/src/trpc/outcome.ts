import { TRPCError } from "@trpc/server"
import type { CommandError } from "@yaip/contracts/agent"
import type { CommandOutcome } from "../domain/execute"

const codeByTag: Record<string, TRPCError["code"]> = {
  Forbidden: "FORBIDDEN",
  NotFound: "NOT_FOUND",
  InvalidState: "BAD_REQUEST",
  ValidationFailed: "BAD_REQUEST",
  ExternalFailure: "INTERNAL_SERVER_ERROR",
  Rejected: "FORBIDDEN",
  Expired: "TIMEOUT",
}

export function toTrpcError(error: CommandError) {
  return new TRPCError({ code: codeByTag[error.tag] ?? "INTERNAL_SERVER_ERROR", message: error.message })
}

/** UI callers act as users, so commands either complete or fail. */
export function unwrapOutcome<Result>(outcome: CommandOutcome<Result>): Result {
  if (outcome.status === "completed") {
    return outcome.result
  }
  if (outcome.status === "awaiting_approval") {
    throw new TRPCError({ code: "CONFLICT", message: "This action is waiting for approval" })
  }
  throw toTrpcError(outcome.error)
}

/** Maps errors thrown by domain services (tagged errors) to tRPC errors. */
export function rethrowDomainError(error: unknown): never {
  if (error && typeof error === "object" && "_tag" in error && "message" in error) {
    throw toTrpcError({ tag: String(error._tag), message: String(error.message) })
  }
  throw error
}
