/**
 * Agent tool registry: every tool the MCP endpoint (`/api/mcp`) can expose.
 *
 * Adding a tool for a feature
 * ---------------------------
 * 1. Write the domain command first (`domain/commands/<feature>.ts`) with its zod input from
 *    `@yaip/contracts/<feature>`. Agents and the UI then share authorization, idempotency,
 *    approval gating, and the audit log.
 * 2. Add one entry to the feature's tool file in `./tools/` (create `./tools/<feature>.ts` and
 *    spread it into `agentTools` below for a new feature):
 *      - state changes: `defineCommandTool({ name, title, description, command, input, present? })`.
 *        `clientRequestId` is added to the input, the scope is the command's permission, and
 *        approval behaviour follows `command.outwardFacing`, so the description says so automatically.
 *      - reads: `defineQueryTool({ name, title, description, input, permission, run })`. Scope every
 *        query by `actor.organizationId` and throw domain errors (`NotFound`, ...) for failures.
 * 3. Name tools `<noun>_<verb>` (e.g. `payment_record`, `credit_note_create`) and write the
 *    description for an agent: what it does, what to call first, and what the result means.
 * 4. Cover the tool in `__tests__/mcp-endpoint.integration.test.ts` and list it in `docs/agent-api.md`.
 *
 * Tools are filtered per key: an agent only sees tools whose permission is in its scopes (and
 * its creator's role), and read-only keys never see command tools.
 */
import { actorCan, type AgentActor } from "../actor"
import { Forbidden, NotFound } from "../errors"
import type { AgentTool } from "./define"
import { activityTools } from "./tools/activity"
import { commandTrackingTools } from "./tools/commands"
import { contactTools } from "./tools/contacts"
import { invoiceTools } from "./tools/invoices"
import { organizationTools } from "./tools/organization"
import { quoteTools } from "./tools/quotes"

const featureTools: AgentTool[] = [
  ...organizationTools,
  ...contactTools,
  ...invoiceTools,
  ...quoteTools,
  ...activityTools,
]

const presenterByCommandType = new Map(
  featureTools.flatMap((tool) => (tool.commandType ? [[tool.commandType, tool.present] as const] : []))
)

const identity = (result: unknown) => result

export const agentTools: readonly AgentTool[] = [
  ...featureTools,
  ...commandTrackingTools((commandType) => presenterByCommandType.get(commandType) ?? identity),
]

const toolsByName = new Map(agentTools.map((tool) => [tool.name, tool]))

if (toolsByName.size !== agentTools.length) {
  throw new Error("Agent tool names must be unique")
}

export function isToolVisible(actor: AgentActor, tool: AgentTool) {
  if (actor.mode === "read_only" && (tool.kind === "command" || tool.requiresWriteMode)) {
    return false
  }
  return tool.permission === null || actorCan(actor, tool.permission)
}

export function visibleAgentTools(actor: AgentActor): AgentTool[] {
  return agentTools.filter((tool) => isToolVisible(actor, tool))
}

/**
 * Looks up a tool the agent may call. Hidden tools fail exactly like unknown ones would in
 * listing, but with a clear reason so agents do not retry.
 */
export function getAgentTool(actor: AgentActor, name: string): AgentTool {
  const tool = toolsByName.get(name)
  if (!tool) {
    throw new NotFound({ message: `Unknown tool ${name}`, entity: "tool", id: name })
  }
  if (!isToolVisible(actor, tool)) {
    throw new Forbidden({
      message:
        actor.mode === "read_only" && tool.kind === "command"
          ? `This agent key is read-only and cannot call ${name}`
          : `This agent key is not allowed to call ${name}`,
      ...(tool.permission ? { permission: tool.permission } : {}),
    })
  }
  return tool
}
