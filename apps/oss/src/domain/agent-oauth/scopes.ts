import { agentScopePresets, type AgentMode } from "@quits/contracts/agent"
import { ALL_PERMISSIONS, isPermission, permissionsForRoles, type OrganizationRole, type Permission } from "../permissions"

/**
 * OAuth scopes are Quits permissions (`invoice:read`, `invoice:send`, ...), so a grant means exactly
 * what an agent key with the same scopes means. `offline_access` is accepted and ignored: refresh
 * tokens go to every client that registered the `refresh_token` grant, whether or not it asks.
 */
export const OFFLINE_ACCESS = "offline_access"

/** What a connector may do. The person consenting picks one; the client cannot pick the mode. */
export type ConnectorPresetId = "read_only" | "drafting_only" | "drafting_with_approved_sending" | "full_access"

export type ConnectorPreset = {
  id: ConnectorPresetId
  mode: AgentMode
  scopes: readonly Permission[] | "all"
}

const readScopes = agentScopePresets.read_only_bookkeeper.scopes as readonly Permission[]

/** Drafting without any permission that leaves Quits or moves money. */
const draftingScopes: readonly Permission[] = [
  ...readScopes,
  "contact:create",
  "contact:update",
  "invoice:create",
  "invoice:update",
  "quote:create",
  "quote:update",
  "agreement:create",
  "agreement:update",
  "deliverable:update",
]

export const connectorPresets: readonly ConnectorPreset[] = [
  { id: "read_only", mode: "read_only", scopes: readScopes },
  { id: "drafting_only", mode: "approval_required", scopes: draftingScopes },
  {
    id: "drafting_with_approved_sending",
    mode: "approval_required",
    scopes: agentScopePresets.drafting_assistant.scopes as readonly Permission[],
  },
  { id: "full_access", mode: "full_access", scopes: "all" },
]

export function getConnectorPreset(id: string): ConnectorPreset | null {
  return connectorPresets.find((preset) => preset.id === id) ?? null
}

/** Agents never manage agents or connectors, whatever their owner may do. */
export function isGrantableScope(permission: Permission) {
  return !permission.startsWith("agent:")
}

/** The scopes a preset grants to someone holding `roles`: never more than they hold. */
export function presetScopesFor(preset: ConnectorPreset, roles: readonly OrganizationRole[]): Permission[] {
  const held = permissionsForRoles(roles).filter(isGrantableScope)
  return preset.scopes === "all" ? held : held.filter((scope) => preset.scopes.includes(scope))
}

/** Scopes advertised in protected resource metadata and in the first `401`: read-only access. */
export const initialChallengeScopes: readonly Permission[] = readScopes

/** Every grantable permission, for authorization server metadata. */
export const supportedScopes: readonly string[] = ALL_PERMISSIONS.filter(isGrantableScope)

export type ParsedScope = { scopes: Permission[]; unknown: string[] }

export function parseScopeParameter(value: string | null | undefined): ParsedScope {
  const parts = [...new Set((value ?? "").split(" ").map((part) => part.trim()).filter(Boolean))]
  const scopes: Permission[] = []
  const unknown: string[] = []
  for (const part of parts) {
    if (part === OFFLINE_ACCESS) continue
    if (isPermission(part) && isGrantableScope(part)) scopes.push(part)
    else unknown.push(part)
  }
  return { scopes, unknown }
}

/**
 * The narrowest preset that covers every requested scope, for preselecting on the consent page.
 * Full access is never preselected: a person has to choose it.
 */
export function suggestPreset(requested: readonly Permission[], roles: readonly OrganizationRole[]): ConnectorPresetId {
  for (const preset of connectorPresets) {
    if (preset.mode === "full_access") continue
    const granted = new Set(presetScopesFor(preset, roles))
    if (requested.every((scope) => granted.has(scope))) {
      return preset.id
    }
  }
  return "drafting_with_approved_sending"
}

export function formatScope(scopes: readonly string[]) {
  return [...scopes].sort().join(" ")
}
