import { createFileRoute, useSearch } from "@tanstack/react-router"
import { useState, useEffect } from "react"
import { trpc } from "../../trpc/client"
import { billingEnabled } from "../../lib/distribution"
import { Button } from "../../components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../../components/ui/card"
import { CreditCard } from "lucide-react"
import { useI18n } from "../../lib/i18n/react"

export const Route = createFileRoute("/_app/billing")({
  validateSearch: (search: Record<string, unknown>) => ({
    success: search.success === "true" ? true : undefined,
    canceled: search.canceled === "true" ? true : undefined,
  }),
  component: BillingPage,
})

type SubscriptionData = {
  status: string
  priceId: string | null
}

function BillingPage() {
  const { t } = useI18n()
  const search = useSearch({ from: "/_app/billing" })
  const [subscription, setSubscription] = useState<SubscriptionData | null>(
    null
  )
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!billingEnabled) {
      setLoading(false)
      return
    }
    trpc.billing.getSubscription
      .query()
      .then((data) => setSubscription(data))
      .catch(() =>
        setError(t("billing.error.loadSubscription"))
      )
      .finally(() => setLoading(false))
  }, [t])

  if (!billingEnabled) {
    return (
      <div className="p-6 max-w-2xl">
        <div className="flex items-center gap-2 mb-6">
          <CreditCard className="size-6" />
          <h1 className="text-2xl font-bold">{t("billing.title")}</h1>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{t("billing.selfHost.title")}</CardTitle>
            <CardDescription>
              {t("billing.selfHost.description")}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  async function handleUpgrade() {
    setActionLoading(true)
    setError(null)
    try {
      const result = await trpc.billing.createCheckoutSession.mutate()
      if (result.url) {
        window.location.href = result.url
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("billing.error.checkout")
      )
    } finally {
      setActionLoading(false)
    }
  }

  async function handleManage() {
    setActionLoading(true)
    setError(null)
    try {
      const result = await trpc.billing.createPortalSession.mutate()
      if (result.url) {
        window.location.href = result.url
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("billing.error.portal")
      )
    } finally {
      setActionLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 mb-6">
          <CreditCard className="size-6" />
          <h1 className="text-2xl font-bold">{t("billing.title")}</h1>
        </div>
        <p className="text-muted-foreground">{t("billing.loading")}</p>
      </div>
    )
  }

  const status = subscription?.status ?? "free"

  const statusLabels: Record<string, { label: string; className: string }> = {
    free: { label: t("billing.status.free"), className: "text-muted-foreground" },
    active: { label: t("billing.status.active"), className: "text-tone-success" },
    canceled: { label: t("billing.status.canceled"), className: "text-tone-warning" },
    past_due: { label: t("billing.status.pastDue"), className: "text-destructive" },
  }

  const statusInfo = statusLabels[status] ?? {
    label: status,
    className: "text-muted-foreground",
  }

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center gap-2 mb-6">
        <CreditCard className="size-6" />
        <h1 className="text-2xl font-bold">{t("billing.title")}</h1>
      </div>

      {search.success && (
        <div className="mb-4 rounded-md border border-tone-success/30 bg-tone-success/10 p-3 text-sm text-foreground">
          {t("billing.flash.success")}
        </div>
      )}
      {search.canceled && (
        <div className="mb-4 rounded-md border border-tone-warning/30 bg-tone-warning/10 p-3 text-sm text-foreground">
          {t("billing.flash.canceled")}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-md border border-tone-danger/30 bg-tone-danger/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("billing.subscription.title")}</CardTitle>
          <CardDescription>
            {t("billing.subscription.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{t("billing.currentPlan")}</p>
              <p className={`text-lg font-semibold ${statusInfo.className}`}>
                {statusInfo.label}
              </p>
            </div>
          </div>

          {status === "free" && (
            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground">
                {t("billing.free.description")}
              </p>
              <Button onClick={handleUpgrade} disabled={actionLoading}>
                {actionLoading
                  ? t("billing.action.redirecting")
                  : t("billing.action.upgrade")}
              </Button>
            </div>
          )}

          {status === "active" && (
            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground">
                {t("billing.active.description")}
              </p>
              <Button
                variant="outline"
                onClick={handleManage}
                disabled={actionLoading}
              >
                {actionLoading
                  ? t("billing.action.redirecting")
                  : t("billing.action.manage")}
              </Button>
            </div>
          )}

          {status === "canceled" && (
            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground">
                {t("billing.canceled.description")}
              </p>
              <Button onClick={handleUpgrade} disabled={actionLoading}>
                {actionLoading
                  ? t("billing.action.redirecting")
                  : t("billing.action.resubscribe")}
              </Button>
            </div>
          )}

          {status === "past_due" && (
            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground">
                {t("billing.pastDue.description")}
              </p>
              <Button
                variant="outline"
                onClick={handleManage}
                disabled={actionLoading}
              >
                {actionLoading
                  ? t("billing.action.redirecting")
                  : t("billing.action.updatePaymentMethod")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
