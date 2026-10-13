import { useEffect, useState } from "react"
import { useRequestOrganizationId } from "../lib/active-organization"
import { loadOrganizationSettings } from "../lib/organization-settings-query"

/** Calendar days from today's issue date in the organization's time zone. */
export function invoiceDueDate(paymentTermsDays: number | null | undefined, timezone: string, now = new Date()) {
  if (paymentTermsDays == null) return ""
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now)
  const part = (type: string) => parts.find(value => value.type === type)!.value
  const date = new Date(`${part("year")}-${part("month")}-${part("day")}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + paymentTermsDays)
  return date.toISOString().slice(0, 10)
}

/** Late settings reads cannot overwrite a user edit, cleared date, or accepted AI draft. */
export function useInvoiceDueDate(): [string, (value: string) => void] {
  const organizationId = useRequestOrganizationId()
  const [state, setState] = useState({ organizationId, value: "", edited: false })
  useEffect(() => {
    if (!organizationId) return
    let cancelled = false
    loadOrganizationSettings().then(settings => {
      if (cancelled) return
      const value = invoiceDueDate(settings.paymentTermsDays, settings.timezone)
      setState(current => current.organizationId === organizationId && current.edited
        ? current : { organizationId, value, edited: false })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [organizationId])
  return [state.organizationId === organizationId ? state.value : "", value => {
    setState({ organizationId, value, edited: true })
  }]
}
