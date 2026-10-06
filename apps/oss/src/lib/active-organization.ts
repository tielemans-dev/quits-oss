import { authClient, useSession } from "./auth-client"

/**
 * The signed-in user's active organization id: `undefined` while the session loads, `null` when
 * none is selected. Data that depends on the organization (such as what the user may do) should
 * be keyed on it so it refreshes when the user switches organization.
 */
export function useActiveOrganizationId(): string | null | undefined {
  const { data: session, isPending } = useSession()
  return isPending ? undefined : (session?.session.activeOrganizationId ?? null)
}

/**
 * Header the tRPC client sends with the organization the UI is acting for. The server only
 * compares it with the session's active organization to reject requests that were started for
 * another organization than the one now active; it is never used for authorization.
 */
export const ORGANIZATION_HEADER = "x-yaip-organization-id"

let requestOrganizationId: string | null = null

/**
 * Records the organization the browser UI is currently acting for. A no-op on the server: the
 * module is shared between server-rendered requests, so it must never carry one user's
 * organization into another request.
 */
export function setRequestOrganizationId(organizationId: string | null | undefined): void {
  if (typeof window === "undefined") return
  requestOrganizationId = organizationId ?? null
}

/** The organization the browser UI is acting for, or `null` when unknown (and on the server). */
export function getRequestOrganizationId(): string | null {
  if (typeof window === "undefined") return null
  return requestOrganizationId
}

/** Headers for a tRPC request: the intended organization when it is known. */
export function organizationRequestHeaders(): Record<string, string> {
  const organizationId = getRequestOrganizationId()
  return organizationId ? { [ORGANIZATION_HEADER]: organizationId } : {}
}

/**
 * Makes `organizationId` the session's active organization and, once the server accepted it,
 * the organization later tRPC requests are sent for. Requests already in flight keep the
 * previous organization, so the server rejects them instead of applying them to the new one.
 */
export async function switchActiveOrganization(organizationId: string) {
  const result = await authClient.organization.setActive({ organizationId })
  if (!result?.error) setRequestOrganizationId(organizationId)
  return result
}
