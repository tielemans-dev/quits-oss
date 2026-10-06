import { useEffect, useState } from "react"
import { trpc } from "../../trpc/client"

export type RecurringCapabilities = { canCreate: boolean; canUpdate: boolean }

const NONE: RecurringCapabilities = { canCreate: false, canUpdate: false }

/**
 * What the current user may do with recurring schedules. Starts with nothing allowed, so controls
 * the server would reject (e.g. for accountants) never flash into view.
 */
export function useRecurringCapabilities(): RecurringCapabilities {
  const [capabilities, setCapabilities] = useState<RecurringCapabilities>(NONE)
  useEffect(() => {
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
  }, [])
  return capabilities
}
