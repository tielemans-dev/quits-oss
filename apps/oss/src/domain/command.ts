import type { Effect } from "effect"
import type { z } from "zod"
import type { DomainError } from "./errors"
import type { Permission } from "./permissions"
import type { Command, Db } from "./services"

export type CommandDefinition<Input = unknown, Result = unknown> = {
  readonly type: string
  readonly permission: Permission
  /**
   * Outward-facing commands send something outside Quits or move money. Agents in
   * `approval_required` mode queue them for a human instead of running them.
   */
  readonly outwardFacing: boolean
  /**
   * For outward-facing commands whose effect depends on what they act on: whether this input
   * needs approval at all. Read before the command runs, outside its transaction, so a handler
   * that skips approval must recheck the condition after locking and refuse if it no longer
   * holds. Without it, an outward-facing command always needs approval.
   */
  readonly requiresApproval?: (input: Input) => Effect.Effect<boolean, DomainError, Db | Command>
  readonly input: z.ZodType<Input>
  /** One line a human approver can act on, e.g. "Send invoice INV-0042 to Acme". */
  readonly summarize: (input: Input) => string
  readonly handle: (input: Input) => Effect.Effect<Result, DomainError, Db | Command>
  /**
   * For outward-facing commands: what a person approving the command is shown, plus a version of
   * the affected document. The command is refused if the version changes before approval runs it,
   * so an agent cannot edit a document after queuing it for review.
   */
  readonly approvalContext?: (input: Input) => Effect.Effect<ApprovalContext, DomainError, Db | Command>
}

export type ApprovalContext = {
  /** One line naming the document, e.g. "Send invoice INV-0042 (1,250.00 DKK) to billing@acme.dk". */
  summary: string
  /** Changes whenever the reviewed document changes. */
  version: string
  /** Key facts shown in the approvals inbox. */
  details: Record<string, string | number | null>
  /** Frozen document preview, persisted in reviewContext. */
  preview?: {
    snapshot: import("@quits/contracts/agreements").AgreementOfferSnapshot
    hash: string
    recipient: string | null
  }
}

export function defineCommand<Input, Result>(
  definition: CommandDefinition<Input, Result>
): CommandDefinition<Input, Result> {
  return definition
}

/** Registries hold commands of every input and result type. */
export type AnyCommandDefinition = CommandDefinition<any, any>
