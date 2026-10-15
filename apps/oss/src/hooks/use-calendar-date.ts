import { useEffect, useState } from "react"
import { formatIsoDate, startOfDayInTimeZone } from "../lib/exports/format"

/** One shared calendar day, refreshed at local midnight and after a suspended tab wakes. */
export function useCalendarDate(timezone?: string | null): string {
  const [instant, setInstant] = useState(Date.now)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    function refresh() {
      clearTimeout(timer)
      const now = new Date()
      const date = formatIsoDate(now, timezone)
      setInstant(now.getTime())
      const tomorrow = new Date(`${date}T00:00:00Z`)
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
      timer = setTimeout(refresh, Math.max(1, startOfDayInTimeZone(tomorrow.toISOString().slice(0, 10), timezone).getTime() - now.getTime()))
    }
    refresh()
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      clearTimeout(timer)
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [timezone])
  return formatIsoDate(new Date(instant), timezone)
}
