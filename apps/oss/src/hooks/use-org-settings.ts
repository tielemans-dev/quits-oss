import { useQueryRevision } from "./use-query-refresh"
import { useEffect, useState } from "react"
import { loadOrganizationSettings } from "../lib/organization-settings-query"
import { useRequestOrganizationId } from "../lib/active-organization"

type OrgSettings = Awaited<ReturnType<typeof loadOrganizationSettings>>

/** The organization's settings, or null until they have loaded. Refreshed with the settings query. */
export function useOrgSettings(): OrgSettings | null {
  const [settings, setSettings] = useState<OrgSettings | null>(null)
  const organizationId = useRequestOrganizationId()
  const query = useQueryRevision(["settings"])
  useEffect(() => {
    if (!organizationId) return
    let cancelled = false
    loadOrganizationSettings()
      .then((loaded) => { if (!cancelled) setSettings(loaded) })
      .catch(() => {
        // Keep the last known settings when they are unavailable.
      })
    return () => { cancelled = true }
  }, [organizationId, query.revision])
  return settings
}
