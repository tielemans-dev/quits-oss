import type { Effect } from "effect"
import type { z } from "zod"
import type { DomainError } from "./errors"
import type { Permission } from "./permissions"
import type { Command, Db } from "./services"

export type CommandDefinition<Input = unknown, Result = unknown> = {
  readonly type: string
  readonly permission: Permission
  /**
   * Outward-facing commands send something outside YAIP or move money. Agents in
   * `approval_required` mode queue them for a human instead of running them.
   */
  readonly outwardFacing: boolean
  readonly input: z.ZodType<Input>
  /** One line a human approver can act on, e.g. "Send invoice INV-0042 to Acme". */
  readonly summarize: (input: Input) => string
  readonly handle: (input: Input) => Effect.Effect<Result, DomainError, Db | Command>
}

export function defineCommand<Input, Result>(
  definition: CommandDefinition<Input, Result>
): CommandDefinition<Input, Result> {
  return definition
}

/** Registries hold commands of every input and result type. */
export type AnyCommandDefinition = CommandDefinition<any, any>
