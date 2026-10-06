import { useSession } from "./auth-client"

/**
 * The signed-in user's active organization id: `undefined` while the session loads, `null` when
 * none is selected. Data that depends on the organization (such as what the user may do) should
 * be keyed on it so it refreshes when the user switches organization.
 */
export function useActiveOrganizationId(): string | null | undefined {
  const { data: session, isPending } = useSession()
  return isPending ? undefined : (session?.session.activeOrganizationId ?? null)
}
