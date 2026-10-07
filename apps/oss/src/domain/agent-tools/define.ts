import { z } from "zod"
import { clientRequestIdSchema, type CommandRecord } from "@quits/contracts/agent"
import type { AgentActor } from "../actor"
import type { CommandDefinition } from "../command"
import { executeCommand, toCommandRecord } from "../execute"
import type { Permission } from "../permissions"
import { toJsonValue } from "./json"

export type AgentToolContext = {
  actor: AgentActor
  /** Aborted when the MCP client cancels the request. */
  signal?: AbortSignal
}

type AnyObjectSchema = z.ZodObject<z.ZodRawShape>

/**
 * One tool an agent can call. Queries read; commands change state through `executeCommand`
 * and always return a `CommandRecord`.
 */
export type AgentTool = {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly kind: "query" | "command"
  readonly input: AnyObjectSchema
  /** Scope the agent needs to see and call the tool. `null` means every key can use it. */
  readonly permission: Permission | null
  /** Hidden from read-only keys, e.g. command status tools that only matter after a command. */
  readonly requiresWriteMode: boolean
  /** Command type for command tools, used to present stored results consistently. */
  readonly commandType: string | null
  readonly run: (context: AgentToolContext, input: unknown) => Promise<unknown>
  /** Shapes a command result for agents; also applied when replaying a stored receipt. */
  readonly present: (result: unknown) => unknown
}

export function defineQueryTool<Input extends AnyObjectSchema>(tool: {
  name: string
  title: string
  description: string
  input: Input
  permission: Permission | null
  requiresWriteMode?: boolean
  run: (context: AgentToolContext, input: z.output<Input>) => Promise<unknown>
}): AgentTool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    kind: "query",
    input: tool.input,
    permission: tool.permission,
    requiresWriteMode: tool.requiresWriteMode ?? false,
    commandType: null,
    run: async (context, input) => toJsonValue(await tool.run(context, input as z.output<Input>)),
    present: (result) => result,
  }
}

const CLIENT_REQUEST_ID_HELP =
  "Idempotency key you choose, e.g. a UUID. Reuse the same value when retrying the same action; " +
  "a retry returns the first outcome instead of running the command twice."

const commandFooter =
  "Requires clientRequestId. Returns a command record with status completed, awaiting_approval, " +
  "rejected, expired, or failed."

const approvalNote =
  "Leaves Quits or moves money: with an approval_required key it is queued for a person " +
  "(status awaiting_approval) and runs only after they approve; call command_wait with the commandId."

/**
 * Exposes a domain command to agents. The tool input is the command input plus
 * `clientRequestId`, so the agent contract stays identical to the UI contract.
 */
export function defineCommandTool<Input extends AnyObjectSchema, Result>(tool: {
  name: string
  title: string
  description: string
  command: CommandDefinition<z.output<Input>, Result>
  input: Input
  present?: (result: Result) => unknown
}): AgentTool {
  const present = (result: unknown) => toJsonValue(tool.present ? tool.present(result as Result) : result)
  const input = tool.input.extend({
    clientRequestId: clientRequestIdSchema.describe(CLIENT_REQUEST_ID_HELP),
  }) as unknown as AnyObjectSchema

  return {
    name: tool.name,
    title: tool.title,
    description: [tool.description, tool.command.outwardFacing ? approvalNote : null, commandFooter]
      .filter(Boolean)
      .join(" "),
    kind: "command",
    input,
    permission: tool.command.permission,
    requiresWriteMode: true,
    commandType: tool.command.type,
    run: async (context, rawInput) => {
      const { clientRequestId, ...commandInput } = rawInput as { clientRequestId: string }
      const outcome = await executeCommand(tool.command, commandInput, {
        actor: context.actor,
        clientRequestId,
      })
      return presentRecord(toCommandRecord(tool.command.type, outcome), present)
    },
    present,
  }
}

export function presentRecord(record: CommandRecord, present: (result: unknown) => unknown): CommandRecord {
  return record.status === "completed" ? { ...record, result: present(record.result) } : record
}
