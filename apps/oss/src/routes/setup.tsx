import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { SetupWizard } from "../components/setup/setup-wizard"
import { Card, CardContent } from "../components/ui/card"
import { resolveRuntimeDistribution } from "../lib/runtime-distribution"
import { useI18n } from "../lib/i18n/react"
import { trpc } from "../trpc/client"
import type { SetupStatus } from "../components/setup/types"

export const Route = createFileRoute("/setup")({
  // Runs in the browser on client navigations, where only the server's answer knows the distribution.
  beforeLoad: ({ context }) => {
    if (resolveRuntimeDistribution(context).isCloud) {
      throw redirect({ to: "/login" })
    }
  },
  component: SetupPage,
})

function SetupPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    trpc.setup.getStatus
      .query()
      .then((nextStatus) => {
        if (cancelled) return
        if (nextStatus.isSetupComplete) {
          navigate({
            to: "/login",
            search: { message: t("setup.complete.loginPrompt") },
          })
          return
        }
        setStatus(nextStatus)
      })
      .catch(() => {
        if (!cancelled) {
          setError(t("setup.error.loadStatus"))
        }
      })

    return () => {
      cancelled = true
    }
  }, [navigate, t])

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-lg">
          <CardContent className="py-8">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-lg">
          <CardContent className="py-8">
            <p className="text-sm text-muted-foreground">{t("setup.loadingStatus")}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <SetupWizard
        initialStatus={status}
        onCompleted={() =>
          navigate({
            to: "/login",
            search: { message: t("setup.complete.loginPrompt") },
          })
        }
      />
    </div>
  )
}
