import { activityReadToolInputSchema } from "@quits/contracts/agent"
import { readActivity } from "../../events"
import { defineQueryTool, type AgentTool } from "../define"

export const activityTools: AgentTool[] = [
  defineQueryTool({
    name: "activity_read",
    title: "Read activity",
    description:
      "Reads the organization's audit log in order: who did what and when, including approvals. " +
      "Page with afterSequence = the previous nextSequence while hasMore is true. Filter to one " +
      "document with aggregateType and aggregateId.",
    input: activityReadToolInputSchema,
    permission: "audit:read",
    run: ({ actor }, input) => readActivity({ organizationId: actor.organizationId, ...input }),
  }),
]
