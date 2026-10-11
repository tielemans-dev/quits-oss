import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { trpc } from "../../trpc/client"
import { useI18n } from "../../lib/i18n/react"
import { useRuntimeDistribution } from "../../lib/runtime-distribution"
import { formatTrialDate, trialDaysLeft } from "../../lib/billing/trial-format"
import type { BillingSubscription } from "../../lib/billing/types"

type TrialContextValue = { subscription: BillingSubscription | null; loading: boolean; error: boolean }
const TrialContext = createContext<TrialContextValue | null>(null)

export function TrialAccessProvider({ children }: { children: ReactNode }) {
  const { billingEnabled } = useRuntimeDistribution()
  const [subscription, setSubscription] = useState<BillingSubscription | null>(null)
  const [loading, setLoading] = useState(billingEnabled)
  const [error, setError] = useState(false)
  const [, setClockTick] = useState(0)
  useEffect(() => {
    if (!billingEnabled) { setLoading(false); return }
    let canceled = false
    trpc.billing.getSubscription.query()
      .then(result => { if (!canceled) setSubscription(result) })
      .catch(() => { if (!canceled) setError(true) })
      .finally(() => { if (!canceled) setLoading(false) })
    return () => { canceled = true }
  }, [billingEnabled])
  useEffect(() => {
    if (!subscription?.trialEnd || subscription.status !== "trialing") return
    const timer = setInterval(() => setClockTick(value => value + 1), 60_000)
    return () => clearInterval(timer)
  }, [subscription?.trialEnd, subscription?.status])
  return <TrialContext.Provider value={{ subscription, loading, error }}>{children}</TrialContext.Provider>
}

export function useTrialAccess() {
  return useContext(TrialContext)
}

export function isReadOnly(subscription: BillingSubscription | null) {
  return Boolean(subscription?.access?.paidOnly && subscription.status !== "active" &&
    (subscription.status !== "trialing" || !subscription.trialEnd || subscription.trialEnd * 1000 <= Date.now()))
}

export function blockedResource(pathname: string): "contacts" | "invoices" | "quotes" | "agreements" | null {
  if (/^\/contacts\/[^/]+\/?$/.test(pathname) && pathname !== "/contacts/new") return "contacts"
  const match = /^\/(contacts|invoices|quotes|agreements)\/(?:new|[^/]+\/edit)\/?$/.exec(pathname)
  return match?.[1] as ReturnType<typeof blockedResource> ?? null
}

export function TrialBanner() {
  const state = useTrialAccess()
  const { t, locale } = useI18n()
  const subscription = state?.subscription
  if (!subscription?.trialEnd || !["trialing", "expired"].includes(subscription.status)) return null
  const ended = subscription.status === "expired" || subscription.trialEnd * 1000 <= Date.now()
  const days = trialDaysLeft(subscription.trialEnd)
  const warning = !ended && days <= 3
  const date = formatTrialDate(subscription.trialEnd, locale)
  const progress = subscription.trialStart
    ? Math.min(100, Math.max(0, ((Date.now() / 1000 - subscription.trialStart) /
      (subscription.trialEnd - subscription.trialStart)) * 100)) : 0
  const title = ended ? t("trial.banner.ended") : warning
    ? days === 1 ? t("trial.banner.tomorrow") : t("trial.banner.warning", { days })
    : t("trial.banner.active", { days })
  const meta = ended ? t("trial.banner.endedMeta") : warning
    ? t("trial.banner.warningMeta") : t("trial.banner.activeMeta", { date })
  return <aside className={`border-b px-4 py-4 md:px-8 ${ended ? "border-[#0B0B0C] bg-[#0B0B0C] text-white" : warning
    ? "border-[#F5D9A8] bg-[#FEF6E7] text-[#0B0B0C]" : "border-[#E7E7E4] bg-white text-[#0B0B0C]"}`}>
    <div className="mx-auto flex max-w-[1216px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <span aria-hidden="true" className={`size-2.5 shrink-0 ${warning ? "bg-[#E8A33A]" : "bg-[#1FC16B]"}`} />
          <strong className="text-sm font-semibold">{title}</strong>
        </div>
        <p className={`mt-1 pl-5 text-sm ${ended ? "text-white/75" : "text-[#6B6B70]"}`}>{meta}</p>
        {!ended && <div className="mt-3 ml-5 h-1 max-w-[360px] overflow-hidden rounded-full bg-black/10" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100} aria-label={title}>
          <div className={`h-full ${warning ? "bg-[#E8A33A]" : "bg-[#1FC16B]"}`} style={{ width: `${progress}%` }} />
        </div>}
      </div>
      <Link to="/billing" search={{ success: undefined, canceled: undefined }} className={`inline-flex min-h-9 items-center justify-center self-start rounded-[7px] px-4 text-sm font-semibold sm:self-auto ${ended
        ? "bg-[#1FC16B] text-[#0B0B0C]" : warning ? "bg-[#0B0B0C] text-white" : "border border-[#E7E7E4] bg-white text-[#0B0B0C]"}`}>
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
  if (isReadOnly(state.subscription)) return <PaywallBlock resource={resource} endDate={state.subscription.trialEnd} />
  return <>{children}</>
}

export function PaywallBlock({ resource, endDate }: { resource: "contacts" | "invoices" | "quotes" | "agreements"; endDate?: number | null }) {
  const { t, locale } = useI18n()
  const date = endDate ? formatTrialDate(endDate, locale) : ""
  return <section className="mx-auto max-w-2xl px-2 py-8 sm:py-14">
    <div className="rounded-[10px] border border-[#E7E7E4] bg-white p-6 sm:p-10">
      <span className="inline-flex rounded-full bg-[#FDECEC] px-3 py-1 text-xs font-semibold text-[#B42318]">{t("trial.paywall.pill")}</span>
      <h1 className="mt-5 max-w-lg text-3xl font-semibold tracking-tight text-[#0B0B0C]">{t("trial.paywall.heading", { resource: t(`trial.resource.${resource}`) })}</h1>
      <p className="mt-3 max-w-lg text-sm leading-6 text-[#6B6B70]">{t("trial.paywall.body", { date })}</p>
      <div className="mt-7 flex flex-wrap gap-3">
        <Link to="/billing" search={{ success: undefined, canceled: undefined }} className="inline-flex min-h-10 items-center rounded-[7px] bg-[#0B0B0C] px-5 text-sm font-semibold text-white">{t("trial.action.upgradeNow")}</Link>
        <Link to="/billing" search={{ success: undefined, canceled: undefined }} className="inline-flex min-h-10 items-center rounded-[7px] border border-[#E7E7E4] px-5 text-sm font-semibold text-[#0B0B0C]">{t("trial.action.plans")}</Link>
      </div>
    </div>
    <div aria-hidden="true" className="pointer-events-none mt-7 rounded-[10px] border border-[#E7E7E4] bg-[#FAFAF9] p-6 opacity-55 grayscale">
      <p className="font-mono text-[11px] font-semibold tracking-widest text-[#6B6B70]">{t("trial.lock")} · {t("trial.paywall.preview")}</p>
      <div className="mt-5 h-9 rounded-[7px] border border-[#E7E7E4] bg-white" />
      <div className="mt-3 h-9 rounded-[7px] border border-[#E7E7E4] bg-white" />
    </div>
  </section>
}
