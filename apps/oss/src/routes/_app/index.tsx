import { useEffect, useState } from "react"
import { useRuntimeDistribution } from "../../lib/runtime-distribution"
import { createFileRoute } from "@tanstack/react-router"

import { DashboardView, DashboardHeader } from "../../components/dashboard/dashboard-view"
import { DashboardError, DashboardSkeleton } from "../../components/dashboard/states"
import { useDashboardSummary } from "../../components/dashboard/use-dashboard-summary"
import { onRequestDone } from "../../components/command-bar/request-events"
import { sendReminderBatch } from "../../components/jobs/reminder-jobs-store"
import { CommandPalette } from "../../components/shell/palette"
import { useI18n } from "../../lib/i18n/react"
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
  const { isCloud, billingEnabled } = useRuntimeDistribution()
  const { t } = useI18n()
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
      commandBar={<CommandPalette inline open onOpenChange={() => {}} can={can} billingEnabled={billingEnabled} placeholder={t("dashboard.commandBar.placeholder")} />}
    />
  )
}
