import { createFileRoute } from "@tanstack/react-router"
import { useCallback, useEffect, useRef, useState } from "react"

import type { DashboardSummary } from "@quits/contracts/dashboard"

import { DashboardView, DashboardHeader } from "../../components/dashboard/dashboard-view"
import { DashboardError, DashboardSkeleton } from "../../components/dashboard/states"
import { trpc } from "../../trpc/client"

export const Route = createFileRoute("/_app/")({
  component: DashboardPage,
})

type Load =
  | { status: "loading" }
  | { status: "error"; retrying: boolean }
  | { status: "ready"; summary: DashboardSummary }

async function sendReminder(invoiceId: string) {
  const result = await trpc.reminders.sendNow.mutate({ invoiceId })
  return { delivery: result.delivery }
}

function DashboardPage() {
  const [load, setLoad] = useState<Load>({ status: "loading" })
  const mounted = useRef(true)

  /**
   * Loads the summary. A reload with figures on screen (after a reminder) keeps them there and
   * swaps them when the new ones arrive, so the page does not flash back to a skeleton.
   */
  const refresh = useCallback(async () => {
    try {
      const summary = await trpc.dashboard.summary.query()
      if (mounted.current) setLoad({ status: "ready", summary })
    } catch {
      // Keep what is on screen after a failed reload; only a first load becomes an error.
      if (mounted.current) setLoad((current) => (current.status === "ready" ? current : { status: "error", retrying: false }))
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
    }
  }, [refresh])

  if (load.status === "loading") {
    return (
      <>
        <DashboardHeader />
        <DashboardSkeleton />
      </>
    )
  }

  if (load.status === "error") {
    return (
      <>
        <DashboardHeader />
        <div>
          <DashboardError
            retrying={load.retrying}
            onRetry={() => {
              setLoad({ status: "error", retrying: true })
              void refresh()
            }}
          />
        </div>
      </>
    )
  }

  return <DashboardView summary={load.summary} sendReminder={sendReminder} onRemindersSettled={refresh} />
}
