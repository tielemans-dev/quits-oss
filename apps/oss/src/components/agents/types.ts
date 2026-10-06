import type { inferRouterOutputs } from "@trpc/server"
import type { AppRouter } from "../../trpc/router"

type AgentsOutputs = inferRouterOutputs<AppRouter>["agents"]

export type AgentKeyRow = AgentsOutputs["listKeys"][number]
export type AgentAccess = AgentsOutputs["access"]
export type ApprovalRow = AgentsOutputs["approvals"][number]
export type CreatedAgentKey = AgentsOutputs["createKey"]
export type DecisionRecord = AgentsOutputs["decide"]
