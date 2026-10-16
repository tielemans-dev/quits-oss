import { useCallback, useEffect, useState } from "react"
import { useRuntimeDistribution } from "../../lib/runtime-distribution"
import { createFileRoute } from "@tanstack/react-router"

import { DashboardView, DashboardHeader } from "../../components/dashboard/dashboard-view"
import { DashboardError, DashboardSkeleton } from "../../components/dashboard/states"
import { useDashboardSummary } from "../../components/dashboard/use-dashboard-summary"
import { MorningCard } from "../../components/dashboard/morning-card"
import { suggestRequest } from "../../components/command-bar/suggest-request"
import { CommandBar } from "../../components/command-bar/command-bar"
import { onRequestDone } from "../../components/command-bar/request-events"
import { permittedRequest, recognizeRequest } from "../../components/command-bar/request-intent"
import { sendReminderBatch } from "../../components/jobs/reminder-jobs-store"
import { openPaletteFrom } from "../../components/shell/palette"
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
  const { load, retry } = useDashboardSummary()
  const { data: session } = useSession()
  const { can } = useShellPermissions()
  const suggest = useCallback((input: string, signal: AbortSignal) => suggestRequest(input, can, signal), [can])
  const recognize = useCallback(permittedRequest(recognizeRequest, can), [can])
  const [newInvoiceId, setNewInvoiceId] = useState<string>()
  // Retain the completed invoice highlight; the mutation subscription refreshes figures.
  useEffect(() => onRequestDone(done => { if (done.kind !== "invoice") return; setNewInvoiceId(done.invoiceId) }), [])

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
      newInvoiceId={newInvoiceId}
      userName={session?.user.name}
      commandBar={<CommandBar recognize={recognize} suggest={suggest} onSearch={(from, query) => openPaletteFrom({ from, query })} />}
      morningCard={<MorningCard canSendReminders={can("invoice:send")} />}
    />
  )
}
