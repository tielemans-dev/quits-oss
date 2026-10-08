import { useEffect, useState } from "react"
import { loadOrganizationSettings } from "../lib/organization-settings-query"
import { useRequestOrganizationId } from "../lib/active-organization"

export function useOrgPricingSettings() {
  const [pricesIncludeTax, setPricesIncludeTax] = useState(false)
  const organizationId = useRequestOrganizationId()
  useEffect(() => {
    if (!organizationId) return
    let cancelled = false
    loadOrganizationSettings().then((settings) => { if (!cancelled) setPricesIncludeTax(settings.pricesIncludeTax) }).catch(() => {})
    return () => { cancelled = true }
  }, [organizationId])
  return { pricesIncludeTax }
}
