import { useQueryRevision } from "./use-query-refresh"
import { useEffect, useState } from "react"
import { useRequestOrganizationId } from "../lib/active-organization"
import { loadOrganizationSettings } from "../lib/organization-settings-query"
import { normalizeCountryCode } from "../lib/validation/localization"

/** Registration only describes the Danish EU VAT setup (as `settings.update` enforces); elsewhere the saved rate stands. */
export function defaultSettingsTaxRate(settings: { taxRate?: number | null; momsRegistered?: boolean | null; countryCode?: string | null; taxRegime?: string | null }) {
  const notVatRegistered = settings.momsRegistered === false && normalizeCountryCode(settings.countryCode) === "DK" && settings.taxRegime === "eu_vat"
  return notVatRegistered ? 0 : settings.taxRate ?? 0
}

/** New documents use the saved rate unless the user or an AI draft has chosen one. */
export function useDocumentTaxRate(): [string, (value: string) => void] {
  const organizationId = useRequestOrganizationId()
  const query = useQueryRevision(["settings"])
  const [state, setState] = useState({ organizationId, value: "0", edited: false })
  useEffect(() => {
    if (!organizationId) return
    let cancelled = false
    loadOrganizationSettings().then(settings => {
      if (cancelled) return
      setState(current => current.organizationId === organizationId && current.edited
        ? current
        : { organizationId, value: String(defaultSettingsTaxRate(settings)), edited: false })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [organizationId, query.revision])
  return [state.organizationId === organizationId ? state.value : "0", value => {
    setState({ organizationId, value, edited: true })
  }]
}
