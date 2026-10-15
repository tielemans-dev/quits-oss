import { useEffect, useState } from "react"
import { useRuntimeDistribution } from "../../lib/runtime-distribution"
import { createFileRoute } from "@tanstack/react-router"

import { DashboardView, DashboardHeader } from "../../components/dashboard/dashboard-view"
import { DashboardError, DashboardSkeleton } from "../../components/dashboard/states"
import { useDashboardSummary } from "../../components/dashboard/use-dashboard-summary"
import { CommandBar } from "../../components/command-bar/command-bar"
import { permittedRequest, recognizeRequest } from "../../components/command-bar/request-intent"
import { sendReminderBatch } from "../../components/jobs/reminder-jobs-store"
import { useShellPermissions } from "../../components/shell/use-shell-permissions"
import { useSession } from "../../lib/auth-client"
import { trpc } from "../../trpc/client"

export const Route = createFileRoute("/_app/")({
  component: DashboardPage,
})

async function sendReminder(invoiceId: string) {
  const result = await trpc.reminders.sendNow.mutate({ invoiceId })
  return { delivery: result.delivery }
}

function DashboardPage() {
  const { isCloud } = useRuntimeDistribution()
  const [readyCompany, setReadyCompany] = useState<string>()
  useEffect(() => {
    if (!isCloud) return
    let cancelled = false
    trpc.onboarding.getStatus.query().then(status => {
      if (!cancelled && status.isComplete && status.version === 2) setReadyCompany(status.values.companyName ?? undefined)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [isCloud])
  const { load, refresh, retry } = useDashboardSummary()
  const { data: session } = useSession()
  const { can } = useShellPermissions()

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

  return (
    <DashboardView
      readyCompany={readyCompany}
      summary={load.summary}
      sendReminder={sendReminder}
      sendReminderBatch={sendReminderBatch}
      onRemindersSettled={refresh}
      userName={session?.user.name}
      commandBar={<CommandBar recognize={permittedRequest(recognizeRequest, can)} />}
    />
  )
}
