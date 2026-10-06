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
 * Records the organization the browser UI is currently acting for; `null` forgets it (signing in
 * or out). Only for explicit changes made in this tab. A no-op on the server: the
 * module is shared between server-rendered requests, so it must never carry one user's
 * organization into another request.
 */
export function setRequestOrganizationId(organizationId: string | null | undefined): void {
  if (typeof window === "undefined") return
  requestOrganizationId = organizationId ?? null
}

/**
 * Takes the organization of the page this tab loaded as the one requests are sent for, unless the
 * tab already acts for one. Called when the app layout renders, which covers the first page load
 * and its hydration. Later renders (after navigating, preloading a link or refreshing the session
 * because another tab switched organization) keep the organization this tab acts for, so a page
 * of one organization can never send its changes for another: the server rejects them instead.
 * Only an explicit switch in this tab (`switchActiveOrganization`) or signing in/out changes it.
 */
export function adoptRequestOrganizationId(organizationId: string | null | undefined): void {
  if (typeof window === "undefined") return
  if (requestOrganizationId !== null) return
  requestOrganizationId = organizationId ?? null
}

/** The organization the browser UI is acting for, or `null` when unknown (and on the server). */
export function getRequestOrganizationId(): string | null {
  if (typeof window === "undefined") return null
  return requestOrganizationId
}

/**
 * Header value for a batch of requests made for different organizations. It matches no
 * organization, so the server rejects the whole batch instead of applying any of it to the
 * organization that is active by then.
 */
export const MIXED_ORGANIZATIONS = "mixed"

/**
 * Headers for tRPC requests made for the given organizations (`null` for unknown). Requests for
 * one organization carry it; requests for several carry `MIXED_ORGANIZATIONS`.
 */
export function organizationRequestHeaders(
  organizationIds: ReadonlyArray<string | null> = [getRequestOrganizationId()]
): Record<string, string> {
  const known = new Set(organizationIds.filter((id): id is string => Boolean(id)))
  if (known.size === 0) return {}
  if (known.size > 1) return { [ORGANIZATION_HEADER]: MIXED_ORGANIZATIONS }
  return { [ORGANIZATION_HEADER]: [...known][0] }
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
