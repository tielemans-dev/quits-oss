import type { AgentMode } from "@yaip/contracts/agent"
import {
  roleHasPermission,
  type OrganizationRole,
  type Permission,
} from "./permissions"

export type UserActor = {
  kind: "user"
  organizationId: string
  userId: string
  roles: OrganizationRole[]
  label: string
}

export type AgentActor = {
  kind: "agent"
  organizationId: string
  agentKeyId: string
  mode: AgentMode
  scopes: Permission[]
  /** Roles of the user who created the key; an agent never exceeds its creator. */
  ownerRoles: OrganizationRole[]
  label: string
}

export type SystemActor = {
  kind: "system"
  organizationId: string
  /** `customer_link`: a customer acting through a signed public document link. */
  reason: "scheduler" | "stripe_webhook" | "recurring" | "migration" | "customer_link"
  label: string
}

export type Actor = UserActor | AgentActor | SystemActor

export function actorCan(actor: Actor, permission: Permission): boolean {
  switch (actor.kind) {
    case "user":
      return roleHasPermission(actor.roles, permission)
    case "agent":
      return actor.scopes.includes(permission) && roleHasPermission(actor.ownerRoles, permission)
    case "system":
      return true
  }
}

/** Stable identity used to scope idempotency keys per caller. */
export function actorKey(actor: Actor): string {
  switch (actor.kind) {
    case "user":
      return `user:${actor.userId}`
    case "agent":
      return `agent:${actor.agentKeyId}`
    case "system":
      return `system:${actor.reason}`
  }
}

export function actorId(actor: Actor): string | null {
  switch (actor.kind) {
    case "user":
      return actor.userId
    case "agent":
      return actor.agentKeyId
    case "system":
      return null
  }
}
