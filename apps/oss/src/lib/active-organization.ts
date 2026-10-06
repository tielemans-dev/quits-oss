import { useSyncExternalStore } from "react"
import { authClient, useSession } from "./auth-client"
import { loadPage } from "./page-navigation"

export { MIXED_ORGANIZATIONS, ORGANIZATION_HEADER } from "./organization-request"

/**
 * The signed-in user's active organization id: `undefined` while the session loads, `null` when
 * none is selected. Data that depends on the organization (such as what the user may do) should
 * be keyed on it so it refreshes when the user switches organization.
 */
export function useActiveOrganizationId(): string | null | undefined {
  const { data: session, isPending } = useSession()
  return isPending ? undefined : (session?.session.activeOrganizationId ?? null)
}

/*
 * The organization this tab acts for: the one every tRPC request names (see `trpc/client.ts`).
 *
 * It has exactly one writer: the authenticated app layout sets it once per page load, after its
 * first render commits (`initializeRequestOrganizationId`), and renders its pages only afterwards.
 * Nothing else changes it — not session refetches, preloads or route loaders. Switching
 * organization, signing in and signing out load a new page instead, which sets it again. So once
 * another tab changes the session's organization, this tab's requests name the old one and the
 * server rejects them rather than applying them to the other organization.
 */
type RequestOrganization = { initialized: boolean; organizationId: string | null }

const UNINITIALIZED: RequestOrganization = { initialized: false, organizationId: null }
let requestOrganization = UNINITIALIZED
const requestOrganizationListeners = new Set<() => void>()

/**
 * Sets the organization this tab acts for, unless it was already set during this page load. Only
 * for the app layout's commit-phase effect; a no-op on the server, where the module is shared
 * between requests of different users.
 */
export function initializeRequestOrganizationId(organizationId: string | null | undefined): void {
  if (typeof window === "undefined" || requestOrganization.initialized) return
  requestOrganization = { initialized: true, organizationId: organizationId ?? null }
  for (const listener of requestOrganizationListeners) listener()
}

/** Whether the organization this tab acts for was set during this page load (never on the server). */
export function isRequestOrganizationInitialized(): boolean {
  if (typeof window === "undefined") return false
  return requestOrganization.initialized
}

/** The organization this tab acts for, or `null` when unknown or none (and on the server). */
export function getRequestOrganizationId(): string | null {
  if (typeof window === "undefined") return null
  return requestOrganization.organizationId
}

function subscribeRequestOrganization(listener: () => void) {
  requestOrganizationListeners.add(listener)
  return () => requestOrganizationListeners.delete(listener)
}

/** The organization this tab acts for, re-rendering once it is set. `null` on the server. */
export function useRequestOrganizationId(): string | null {
  return useSyncExternalStore(subscribeRequestOrganization, getRequestOrganizationId, () => null)
}

/** Whether the organization this tab acts for is set, re-rendering once it is. `false` on the server. */
export function useRequestOrganizationInitialized(): boolean {
  return useSyncExternalStore(subscribeRequestOrganization, isRequestOrganizationInitialized, () => false)
}

/*
 * Whether the server rejected one of this tab's requests because the session's active organization
 * changed (in another tab). Set by the tRPC client; the app layout shows a banner asking to reload.
 */
let organizationChanged = false
const organizationChangedListeners = new Set<() => void>()

/** Records that the session's active organization is no longer the one this tab acts for. */
export function markOrganizationChanged(): void {
  if (typeof window === "undefined" || organizationChanged) return
  organizationChanged = true
  for (const listener of organizationChangedListeners) listener()
}

/** Whether the active organization was changed in another tab (never on the server). */
export function isOrganizationChanged(): boolean {
  return typeof window !== "undefined" && organizationChanged
}

function subscribeOrganizationChanged(listener: () => void) {
  organizationChangedListeners.add(listener)
  return () => organizationChangedListeners.delete(listener)
}

/** Whether the active organization was changed in another tab, so this page must be reloaded. */
export function useOrganizationChanged(): boolean {
  return useSyncExternalStore(subscribeOrganizationChanged, isOrganizationChanged, () => false)
}

/** Forgets this page load's organization state. Tests only: a real page load starts afresh. */
export function resetRequestOrganizationForTesting(): void {
  requestOrganization = UNINITIALIZED
  organizationChanged = false
  for (const listener of requestOrganizationListeners) listener()
  for (const listener of organizationChangedListeners) listener()
}

export type SwitchOrganizationOptions = {
  /** Page to load once the switch is accepted; defaults to `/`. */
  destination?: string
  /**
   * Whether the flow that asked for the switch was abandoned meanwhile (for example its component
   * unmounted). The session's organization has changed anyway, so this tab's next request is
   * rejected and the organization-changed banner asks the user to reload.
   */
  isCancelled?: () => boolean
}

/**
 * Makes `organizationId` the session's active organization, then loads `destination` as a new page,
 * which acts for it. Never changes the organization this page acts for: requests still running
 * keep naming the previous organization, so the server rejects them instead of applying them to
 * the new one. Returns Better Auth's result; nothing is loaded when the switch failed.
 */
export async function switchActiveOrganization(organizationId: string, options: SwitchOrganizationOptions = {}) {
  const result = await authClient.organization.setActive({ organizationId })
  if (!result?.error && !options.isCancelled?.()) loadPage(options.destination ?? "/")
  return result
}
