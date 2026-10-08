import { useEffect, useState } from "react"
import { normalizeCurrency } from "../lib/i18n/locale"
import { loadOrganizationSettings } from "../lib/organization-settings-query"
import { useRequestOrganizationId } from "../lib/active-organization"

type CurrencySettings = {
  defaultCurrency?: string | null
  currency?: string | null
}

export function resolveOrgCurrency(settings?: CurrencySettings | null): string {
  return normalizeCurrency(settings?.defaultCurrency ?? settings?.currency ?? null)
}

export function useOrgCurrency() {
  const [currency, setCurrency] = useState<string>("USD")

  const organizationId = useRequestOrganizationId()
  useEffect(() => {
    if (!organizationId) return
    let cancelled = false
    loadOrganizationSettings()
      .then((settings) => {
        if (!cancelled) {
          setCurrency(resolveOrgCurrency(settings))
        }
      })
      .catch(() => {
        // Keep fallback currency when settings are unavailable.
      })

    return () => {
      cancelled = true
    }
  }, [organizationId])

  return currency
}
