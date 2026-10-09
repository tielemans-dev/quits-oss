import { createFileRoute } from "@tanstack/react-router"

import { DashboardView, DashboardHeader } from "../../components/dashboard/dashboard-view"
import { DashboardError, DashboardSkeleton } from "../../components/dashboard/states"
import { useDashboardSummary } from "../../components/dashboard/use-dashboard-summary"
import { trpc } from "../../trpc/client"

export const Route = createFileRoute("/_app/")({
  component: DashboardPage,
})

async function sendReminder(invoiceId: string) {
  const result = await trpc.reminders.sendNow.mutate({ invoiceId })
  return { delivery: result.delivery }
}

function DashboardPage() {
  const { load, refresh, retry } = useDashboardSummary()

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
          <DashboardError retrying={load.retrying} onRetry={retry} />
        </div>
      </>
    )
  }

  return <DashboardView summary={load.summary} sendReminder={sendReminder} onRemindersSettled={refresh} />
}
