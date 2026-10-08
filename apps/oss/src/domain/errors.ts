import { Data } from "effect"
import type { CommandError } from "@quits/contracts/agent"

export class Forbidden extends Data.TaggedError("Forbidden")<{
  readonly message: string
  readonly permission?: string
}> {}

export class NotFound extends Data.TaggedError("NotFound")<{
  readonly message: string
  readonly entity: string
  readonly id?: string
}> {}

/** The command is valid but not allowed in the aggregate's current state. */
export class InvalidState extends Data.TaggedError("InvalidState")<{
  readonly message: string
  readonly code: string
  /** Facts a person or agent can act on, e.g. which draft holds a reservation. */
  readonly details?: Readonly<Record<string, string | number | boolean | null>>
}> {}

export class ValidationFailed extends Data.TaggedError("ValidationFailed")<{
  readonly message: string
  readonly issues?: ReadonlyArray<{ path: string; message: string }>
}> {}

export class ExternalFailure extends Data.TaggedError("ExternalFailure")<{
  readonly message: string
  readonly service: string
  /** Names the failure for clients that retry it, such as `number_contention`. */
  readonly code?: string
  readonly cause?: unknown
}> {}

export type DomainError = Forbidden | NotFound | InvalidState | ValidationFailed | ExternalFailure

export function serializeDomainError(error: DomainError): CommandError {
  return {
    tag: error._tag,
    message: error.message,
    ...("code" in error ? { code: error.code } : {}),
    ...("details" in error && error.details ? { details: { ...error.details } } : {}),
    ...("issues" in error && error.issues ? { issues: [...error.issues] } : {}),
  }
}
