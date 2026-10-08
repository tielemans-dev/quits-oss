import { useCallback, useEffect, useRef, useState } from "react"

import type { DashboardSummary } from "@quits/contracts/dashboard"

import { trpc } from "../../trpc/client"

export type SummaryLoad =
  | { status: "loading" }
  | { status: "error"; retrying: boolean }
  | { status: "ready"; summary: DashboardSummary }

/** The one place the dashboard reads its summary, so the data source can change without the page noticing. */
const fetchSummary = () => trpc.dashboard.summary.query()

/**
 * Loads the summary and reloads it on `refresh`. A reload with figures on screen (after a reminder)
 * keeps them there and swaps them when the new ones arrive, so the page does not flash back to a
 * skeleton; only a first load can become an error. `retry` is the error state's button.
 */
export function useDashboardSummary() {
  const [load, setLoad] = useState<SummaryLoad>({ status: "loading" })
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const summary = await fetchSummary()
      if (mounted.current) setLoad({ status: "ready", summary })
    } catch {
      if (mounted.current) {
        setLoad((current) => (current.status === "ready" ? current : { status: "error", retrying: false }))
      }
    }
  }, [])

  const retry = useCallback(() => {
    setLoad({ status: "error", retrying: true })
    void refresh()
  }, [refresh])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
    }
  }, [refresh])

  return { load, refresh, retry }
}
