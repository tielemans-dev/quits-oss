import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { trpc } from "../../trpc/client"
import { useI18n } from "../../lib/i18n/react"
import { useRuntimeDistribution } from "../../lib/runtime-distribution"
import { formatTrialDate } from "../../lib/billing/trial-format"
import type { BillingSubscription } from "../../lib/billing/types"

type TrialContextValue = { subscription: BillingSubscription | null; loading: boolean; error: boolean }
const TrialContext = createContext<TrialContextValue | null>(null)

export function TrialAccessProvider({ children }: { children: ReactNode }) {
  const { billingEnabled } = useRuntimeDistribution()
  const [subscription, setSubscription] = useState<BillingSubscription | null>(null)
  const [loading, setLoading] = useState(billingEnabled)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!billingEnabled) { setLoading(false); return }
    let canceled = false
    let pending = false
    const refresh = () => {
      if (pending) return
      pending = true
      return trpc.billing.getSubscription.query()
        .then(result => { if (!canceled) { setSubscription(result); setError(false) } })
        .catch(() => { if (!canceled) setError(true) })
        .finally(() => { pending = false; if (!canceled) setLoading(false) })
    }
    void refresh()
    const timer = setInterval(refresh, 60_000)
    window.addEventListener("focus", refresh)
    return () => { canceled = true; clearInterval(timer); window.removeEventListener("focus", refresh) }
  }, [billingEnabled])
  return <TrialContext.Provider value={{ subscription, loading, error }}>{children}</TrialContext.Provider>
}

export function useTrialAccess() {
  return useContext(TrialContext)
}

export function isReadOnly(subscription: BillingSubscription | null) {
  return Boolean(subscription && (!subscription.organizationAccess || subscription.organizationAccess.state === "read_only"))
}

export function blockedResource(pathname: string): "contacts" | "invoices" | "quotes" | "agreements" | null {
  if (/^\/contacts\/[^/]+\/?$/.test(pathname) && pathname !== "/contacts/new") return "contacts"
  const match = /^\/(contacts|invoices|quotes|agreements)\/(?:new|[^/]+\/edit)\/?$/.exec(pathname)
  return match?.[1] as ReturnType<typeof blockedResource> ?? null
}

export function TrialBanner() {
  const state = useTrialAccess()
  const { t, locale } = useI18n()
  const access = state?.subscription?.organizationAccess
  if (!access || (access.state !== "trial" && access.state !== "read_only")) return null
  const ended = access.state === "read_only"
  const days = access.state === "trial" ? access.daysLeft : 0
  const warning = !ended && days <= 3
  const date = access.trialEnd ? formatTrialDate(access.trialEnd, locale) : ""
  const progress = access.state === "trial" ? access.progress : 0
  const title = ended ? t("trial.banner.ended") : warning
    ? days === 1 ? t("trial.banner.tomorrow") : t("trial.banner.warning", { days })
    : t("trial.banner.active", { days })
  const meta = ended ? t("trial.banner.endedMeta") : warning
    ? t("trial.banner.warningMeta") : t("trial.banner.activeMeta", { date })
  return <aside className={`border-b px-4 py-4 md:px-8 ${ended ? "border-foreground bg-foreground text-background" : warning
    ? "border-tone-warning/40 bg-tone-warning/14 text-foreground" : "border-border bg-card text-foreground"}`}>
    <div className="mx-auto flex max-w-[1216px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <span aria-hidden="true" className={`size-2.5 shrink-0 ${warning ? "bg-tone-warning" : "bg-settled"}`} />
          <strong className="text-sm font-semibold">{title}</strong>
        </div>
        <p className={`mt-1 pl-5 text-sm ${ended ? "text-white/75" : "text-muted-foreground"}`}>{meta}</p>
        {!ended && <div className="mt-3 ml-5 h-1 max-w-[360px] overflow-hidden rounded-full bg-black/10" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100} aria-label={title}>
          <div className={`h-full ${warning ? "bg-tone-warning" : "bg-settled"}`} style={{ width: `${progress}%` }} />
        </div>}
      </div>
      <Link to="/billing" search={{ success: undefined, canceled: undefined }} className={`inline-flex min-h-9 items-center justify-center self-start rounded-md px-4 text-sm font-semibold sm:self-auto ${ended
        ? "bg-settled text-foreground" : warning ? "bg-foreground text-background" : "border border-border bg-card text-foreground"}`}>
        {ended ? t("trial.action.upgradeNow") : warning ? t("trial.action.upgrade") : t("trial.action.plans")}
      </Link>
    </div>
  </aside>
}

export function TrialRouteGate({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { billingEnabled } = useRuntimeDistribution()
  const state = useTrialAccess()
  const resource = blockedResource(pathname)
  if (!billingEnabled || !resource) return <>{children}</>
  if (state?.loading) return <div aria-busy="true" className="p-6" />
  if (state?.error || !state?.subscription) return <div role="alert" className="p-6">Billing status is unavailable. Reload this page.</div>
  if (isReadOnly(state.subscription)) return <PaywallBlock resource={resource} endDate={state.subscription.organizationAccess?.state === "read_only" ? state.subscription.organizationAccess.trialEnd : null} />
  return <>{children}</>
}

export function PaywallBlock({ resource, endDate }: { resource: "contacts" | "invoices" | "quotes" | "agreements"; endDate?: number | null }) {
  const { t, locale } = useI18n()
  const date = endDate ? formatTrialDate(endDate, locale) : ""
  return <section className="mx-auto max-w-2xl px-2 py-8 sm:py-14">
    <div className="rounded-lg border border-border bg-card p-6 sm:p-10">
      <span className="inline-flex rounded-full bg-destructive/10 px-3 py-1 text-xs font-semibold text-destructive">{t("trial.paywall.pill")}</span>
      <h1 className="mt-5 max-w-lg text-3xl font-semibold tracking-tight text-foreground">{t("trial.paywall.heading", { resource: t(`trial.resource.${resource}`) })}</h1>
      <p className="mt-3 max-w-lg text-sm leading-6 text-muted-foreground">{endDate ? t("trial.paywall.body", { date }) : t("trial.paywall.bodyNoDate")}</p>
      <div className="mt-7 flex flex-wrap gap-3">
        <Link to="/billing" search={{ success: undefined, canceled: undefined }} className="inline-flex min-h-10 items-center rounded-md bg-foreground px-5 text-sm font-semibold text-background">{t("trial.action.upgradeNow")}</Link>
        <Link to="/billing" search={{ success: undefined, canceled: undefined }} className="inline-flex min-h-10 items-center rounded-md border border-border px-5 text-sm font-semibold text-foreground">{t("trial.action.plans")}</Link>
      </div>
    </div>
    <div aria-hidden="true" className="pointer-events-none mt-7 rounded-lg border border-border bg-canvas p-6 opacity-55 grayscale">
      <p className="font-mono text-2xs font-semibold tracking-widest text-muted-foreground">{t("trial.lock")} · {t("trial.paywall.preview")}</p>
      <div className="mt-5 h-9 rounded-md border border-border bg-card" />
      <div className="mt-3 h-9 rounded-md border border-border bg-card" />
    </div>
  </section>
}
