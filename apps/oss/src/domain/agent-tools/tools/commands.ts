import { setTimeout as sleep } from "node:timers/promises"
import {
  commandStatusToolInputSchema,
  commandWaitToolInputSchema,
  type CommandRecord,
} from "@quits/contracts/agent"
import { prisma } from "../../../lib/db"
import { actorKey, type AgentActor } from "../../actor"
import { expireStaleApprovals } from "../../approvals"
import { NotFound } from "../../errors"
import { receiptToOutcome, toCommandRecord } from "../../execute"
import { defineQueryTool, presentRecord, type AgentTool } from "../define"

const POLL_INTERVAL_MS = 500

type Presenter = (commandType: string) => (result: unknown) => unknown

/** Reads a receipt the calling agent created. Other callers' receipts look like they do not exist. */
async function readOwnCommand(actor: AgentActor, commandId: string, presenterFor: Presenter) {
  await expireStaleApprovals(actor.organizationId)
  const receipt = await prisma.commandReceipt.findFirst({
    where: { id: commandId, organizationId: actor.organizationId, actorKey: actorKey(actor) },
  })
  if (!receipt) {
    throw new NotFound({ message: "Command not found for this agent key", entity: "command", id: commandId })
  }
  const record = toCommandRecord(receipt.commandType, await receiptToOutcome(receipt))
  return presentRecord(record, presenterFor(receipt.commandType))
}

/** `command_status` and `command_wait`; they present results with the issuing tool's presenter. */
export function commandTrackingTools(presenterFor: Presenter): AgentTool[] {
  return [
    defineQueryTool({
      name: "command_status",
      title: "Command status",
      description:
        "Returns the current command record for a commandId this agent key received from a command " +
        "tool. Use it to check a command that was awaiting_approval.",
      input: commandStatusToolInputSchema,
      permission: null,
      requiresWriteMode: true,
      run: ({ actor }, input) => readOwnCommand(actor, input.commandId, presenterFor),
    }),

    defineQueryTool({
      name: "command_wait",
      title: "Wait for command",
      description:
        "Waits until a command leaves awaiting_approval (a person approved or rejected it, or it " +
        "expired) or timeoutMs (max 30000) passes, then returns { command, timedOut }. If timedOut " +
        "is true, call command_wait again later; do not resend the command.",
      input: commandWaitToolInputSchema,
      permission: null,
      requiresWriteMode: true,
      run: async ({ actor, signal }, input) => {
        const deadline = Date.now() + input.timeoutMs
        let command: CommandRecord = await readOwnCommand(actor, input.commandId, presenterFor)
        while (command.status === "awaiting_approval") {
          const remaining = deadline - Date.now()
          if (remaining <= 0 || signal?.aborted) {
            return { command, timedOut: true }
          }
          await sleep(Math.min(POLL_INTERVAL_MS, remaining), undefined, { signal }).catch(() => {})
          command = await readOwnCommand(actor, input.commandId, presenterFor)
        }
        return { command, timedOut: false }
      },
    }),
  ]
}
