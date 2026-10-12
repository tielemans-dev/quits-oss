import { useEffect, useState } from "react"
import { useRequestOrganizationId } from "../lib/active-organization"
import { loadOrganizationSettings } from "../lib/organization-settings-query"

/** New documents use the saved rate unless the user or an AI draft has chosen one. */
export function useDocumentTaxRate(): [string, (value: string) => void] {
  const organizationId = useRequestOrganizationId()
  const [state, setState] = useState({ organizationId, value: "0", edited: false })
  useEffect(() => {
    if (!organizationId) return
    let cancelled = false
    loadOrganizationSettings().then(settings => {
      if (cancelled) return
      setState(current => current.organizationId === organizationId && current.edited
        ? current
        : { organizationId, value: String(settings.taxRate ?? 0), edited: false })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [organizationId])
  return [state.organizationId === organizationId ? state.value : "0", value => {
    setState({ organizationId, value, edited: true })
  }]
}
