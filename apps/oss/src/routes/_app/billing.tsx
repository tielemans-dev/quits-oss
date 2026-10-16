import { createFileRoute, useSearch } from "@tanstack/react-router"
import { useState } from "react"
import { trpc } from "../../trpc/client"
import { useRuntimeDistribution } from "../../lib/runtime-distribution"
import { useTrialAccess } from "../../components/billing/trial-access"
import { Button } from "../../components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../../components/ui/card"
import { AlertTriangle, CreditCard } from "lucide-react"
import { useI18n } from "../../lib/i18n/react"
import type { BillingSubscription } from "../../lib/billing/types"
import { formatPlanAmount, formatPlanPrice, formatTrialDate } from "../../lib/billing/trial-format"

export const Route = createFileRoute("/_app/billing")({
  validateSearch: (search: Record<string, unknown>) => ({
    success: search.success === "true" ? true : undefined,
    canceled: search.canceled === "true" ? true : undefined,
  }),
  component: BillingPage,
})

function BillingPage() {
  const { t } = useI18n()
  const { billingEnabled } = useRuntimeDistribution()
  const search = useSearch({ from: "/_app/billing" })
  const trial = useTrialAccess()
  const subscription = trial?.subscription ?? null
  const loading = trial?.loading ?? billingEnabled
  const [actionLoading, setActionLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!billingEnabled || subscription?.organizationAccess?.state === "self_hosted") {
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

  if (trial?.error || (!loading && billingEnabled && !subscription?.organizationAccess)) return <p role="alert">{t("billing.error.loadSubscription")}</p>

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

  const status = subscription?.organizationAccess.state ?? "self_hosted"

  const statusLabels: Record<string, { label: string; className: string }> = {
    self_hosted: { label: t("billing.status.free"), className: "text-muted-foreground" },
    subscribed: { label: t("billing.status.active"), className: "text-tone-success" },
    read_only: { label: t("billing.status.canceled"), className: "text-tone-warning" },
    trial: { label: t("trial.status.active"), className: "text-tone-success" },
  }

  const statusInfo = statusLabels[status] ?? {
    label: status,
    className: "text-muted-foreground",
  }

  if (subscription?.organizationAccess) {
    return <HostedBillingPage subscription={subscription} actionLoading={actionLoading} error={error}
      success={search.success} canceled={search.canceled}
      onUpgrade={subscription.access?.hasSubscription ? handleManage : handleUpgrade} onManage={handleManage} />
  }

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center gap-2 mb-6">
        <CreditCard className="size-6" />
        <h1 className="text-2xl font-bold">{t("billing.title")}</h1>
      </div>

      {search.success && subscription?.organizationAccess.state === "subscribed" && (
        <div className="mb-4 rounded-md border border-tone-success/30 bg-tone-success/10 p-3 text-sm text-foreground">
          {t("billing.flash.success")}
        </div>
      )}
      {search.canceled && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-tone-warning/30 bg-tone-warning/14 p-3 text-sm text-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-tone-warning" aria-hidden="true" />
          <span>{t("billing.flash.canceled")}</span>
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
              {(!subscription?.access?.paidOnly || subscription.access.hasSubscription) && <p className={`text-lg font-semibold ${statusInfo.className}`}>
                {statusInfo.label}
              </p>}
            </div>
          </div>

          {subscription?.access?.paidOnly && (
            <div className="grid gap-2">
              {subscription.access.checkoutAvailable && <Button onClick={handleUpgrade} disabled={actionLoading}>
                {actionLoading ? t("billing.action.redirecting") : t("billing.action.upgrade")}
              </Button>}
              {subscription.access.portalAvailable && <Button variant="outline" onClick={handleManage} disabled={actionLoading}>
                {actionLoading ? t("billing.action.redirecting") : t("billing.action.manage")}
              </Button>}
            </div>
          )}

          {!subscription?.access?.paidOnly && status === "self_hosted" && (
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

          {!subscription?.access?.paidOnly && status === "subscribed" && (
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

          {!subscription?.access?.paidOnly && status === "read_only" && (
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

          {!subscription?.access?.paidOnly && status === "read_only" && (
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

function HostedBillingPage({ subscription, actionLoading, error, success, canceled, onUpgrade, onManage }: {
  subscription: BillingSubscription
  actionLoading: boolean
  error: string | null
  success?: boolean
  canceled?: boolean
  onUpgrade: () => void
  onManage: () => void
}) {
  const { t, locale } = useI18n()
  const plan = subscription.plan
  const price = plan ? formatPlanPrice(plan, locale) : null
  const access = subscription.organizationAccess
  const trialEnd = (access.state === "trial" || access.state === "read_only") && access.trialEnd ? formatTrialDate(access.trialEnd, locale) : null
  const isTrial = access.state === "trial"
  const isPaid = access.state === "subscribed"
  const isComped = access.state === "complimentary"
  const days = access.state === "trial" ? access.daysLeft : 0
  const progress = access.state === "trial" ? access.progress : 0
  return <div className="mx-auto max-w-4xl px-1 py-1 text-foreground">
    <div className="mb-7 flex items-center gap-2">
      <span aria-hidden="true" className="size-2.5 bg-settled" />
      <h1 className="text-3xl font-semibold tracking-tight">{t("billing.title")}</h1>
    </div>
    {success && isPaid && <p className="mb-4 rounded-md bg-settled/14 p-3 text-sm text-settled-text">{t("billing.flash.success")}</p>}
    {canceled && <p className="mb-4 rounded-md bg-tone-warning/14 p-3 text-sm">{t("billing.flash.canceled")}</p>}
    {error && <p role="alert" className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    <div className={`grid gap-5 ${isComped ? "" : "md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"}`}>
      <section className="rounded-lg border border-border bg-card p-6">
        <p className="font-mono text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">{t("billing.currentPlan")}</p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-semibold">{isTrial ? t("trial.billing.trial") : plan?.name ?? "quits"}</h2>
          <span className="rounded-full bg-settled/14 px-2.5 py-1 text-xs font-semibold text-settled-text">
            {isComped ? t("trial.billing.comped") : isPaid ? t("trial.billing.paid") : isTrial ? t("trial.status.active") : t("trial.paywall.pill")}
          </span>
        </div>
        {isTrial && trialEnd && <>
          <p className="mt-3 text-sm text-muted-foreground">{t("trial.billing.end", { date: trialEnd })}</p>
          <div className="mt-6 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100} aria-label={t("trial.banner.active", { days })}>
            <div className="h-full bg-settled" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-5 text-sm text-muted-foreground">{t("trial.billing.data")}</p>
        </>}
        {!isTrial && !isPaid && !isComped && <p className="mt-4 text-sm text-muted-foreground">{t("trial.banner.endedMeta")}</p>}
        {isPaid && <>
          {subscription.renewalDate && <p className="mt-3 text-sm text-muted-foreground">{t("trial.billing.renews", { date: formatTrialDate(subscription.renewalDate, locale) })}</p>}
          {subscription.paymentMethod && <p className="mt-2 text-sm text-muted-foreground">{t("trial.billing.card", {
            brand: subscription.paymentMethod.brand, last4: subscription.paymentMethod.last4,
          })}</p>}
          <div className="mt-6 grid gap-2">
            <Button onClick={onManage} disabled={actionLoading}>{t("trial.billing.manage")}</Button>
            <Button variant="outline" onClick={onManage} disabled={actionLoading}>{t("trial.billing.cancel")}</Button>
          </div>
        </>}
      </section>
      {!isComped && <section className="rounded-lg border border-border bg-card p-6">
        <p className="font-mono text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">{t("billing.subscription.title")}</p>
        <h2 className="mt-5 text-2xl font-semibold">{plan?.name ?? "quits"}</h2>
        {price && <><p className="mt-3 text-3xl font-semibold tracking-tight">{price}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("trial.billing.priceMeta")}</p></>}
        <ul className="mt-6 grid gap-3 text-sm">
          {([1, 2, 3, 4, 5] as const).map(number => <li key={number} className="flex gap-2.5"><span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 bg-settled" />{t(`trial.billing.include${number}`)}</li>)}
        </ul>
        {!isPaid && !isComped && <>
          <Button className="mt-7 h-11 w-full rounded-md bg-foreground text-background hover:bg-foreground/90" onClick={onUpgrade} disabled={actionLoading}>
            {actionLoading ? t("billing.action.redirecting") : subscription.access?.portalAvailable
              ? t("trial.billing.manage") : price ? t("trial.billing.cta", { price }) : t("trial.action.upgradeNow")}
          </Button>
          <p className="mt-3 text-center text-xs leading-5 text-muted-foreground">{t("trial.billing.note")}</p>
        </>}
      </section>}
    </div>
    {isPaid && <section className="mt-5 rounded-lg border border-border bg-card p-6">
      <h2 className="text-lg font-semibold">{t("trial.billing.invoices")}</h2>
      <ul className="mt-4 divide-y divide-border">
        {(subscription.invoiceHistory ?? []).map(invoice => <li key={invoice.id} className="flex items-center justify-between gap-4 py-3 text-sm">
          <span>{formatTrialDate(invoice.created, locale)}</span>
          {invoice.url ? <a href={invoice.url} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2">{plan ? formatPlanAmount({ ...plan, unitAmount: invoice.amountPaid, taxBehavior: "exclusive" }, locale) : invoice.amountPaid}</a>
            : <span>{plan ? formatPlanAmount({ ...plan, unitAmount: invoice.amountPaid, taxBehavior: "exclusive" }, locale) : invoice.amountPaid}</span>}
        </li>)}
      </ul>
    </section>}
  </div>
}
