import { useEffect, useState } from "react"
import { useSession } from "../../lib/auth-client"
import { trpc } from "../../trpc/client"

export type RecurringCapabilities = { canCreate: boolean; canUpdate: boolean }

const NONE: RecurringCapabilities = { canCreate: false, canUpdate: false }

/**
 * What the current user may do with recurring schedules in the active organization. Starts with
 * nothing allowed, so controls the server would reject (e.g. for accountants) never flash into
 * view, and starts over whenever the user switches organization: their role may differ there.
 */
export function useRecurringCapabilities(): RecurringCapabilities {
  const { data: session, isPending } = useSession()
  // `undefined` while the session loads; the organization ID (or null) once it is known.
  const organizationId = isPending ? undefined : (session?.session.activeOrganizationId ?? null)
  const [capabilities, setCapabilities] = useState<RecurringCapabilities>(NONE)
  useEffect(() => {
    setCapabilities(NONE)
    if (organizationId === undefined) return
    let cancelled = false
    Promise.resolve()
      .then(() => trpc.recurring.capabilities.query())
      .then((result) => {
        if (!cancelled) setCapabilities(result)
      })
      .catch(() => {
        // Without capabilities the page stays read-only.
      })
    return () => {
      cancelled = true
    }
  }, [organizationId])
  return capabilities
}
