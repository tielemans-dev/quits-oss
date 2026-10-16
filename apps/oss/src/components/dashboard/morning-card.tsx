import { useQueryRefresh } from "../../hooks/use-query-refresh"
import { Link } from "@tanstack/react-router"
import { Clock, Percent, Send, type LucideIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"

import { useCalendarDate } from "../../hooks/use-calendar-date"
import { formatCurrency, formatDate } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { cn } from "../../lib/utils"
import { remindedInvoiceIds } from "../../lib/jobs/reminder-tracker"
import { trpc } from "../../trpc/client"
import { announceRequestOpen, onRequestDone } from "../command-bar/request-events"
import { stagger } from "../command-bar/request-card-slot"
import { useReminderJobs } from "../jobs/reminder-jobs-store"
import { Button } from "../ui/button"
import { tCount } from "./i18n"
import { presentMorning, readinessKey, type DraftInvoice, type MorningSettings } from "./morning-model"

type Loaded = { invoices: DraftInvoice[]; settings: MorningSettings | null; readyKeys: Set<string> }

/** Whether a draft's customer and currency can be sent to, by the same check the send button makes. */
async function readyKeysOf(invoices: readonly DraftInvoice[]) {
  const drafts = invoices.filter((invoice) => invoice.status === "draft" && invoice.contactId)
  const keys = new Map(drafts.map((draft) => [readinessKey(draft), draft]))
  const ready = await Promise.all(
    [...keys].map(async ([key, { contactId, currency }]) => {
      try {
        const state = await trpc.invoices.sendReadiness.query({ contactId: contactId!, currency })
        return !state.policyUnavailable && state.issues.length === 0 && state.recipientVersion ? key : null
      } catch {
        return null
      }
    })
  )
  return new Set(ready.filter((key): key is string => key !== null))
}

function Row({ icon: Icon, tone, title, detail, action, index }: {
  icon: LucideIcon
  tone: string
  title: string
  detail?: string
  action?: ReactNode
  index: number
}) {
  return (
    <li {...stagger(index)} className="flex min-w-0 items-start gap-3 p-4">
      <span aria-hidden="true" className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${tone}`}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <p className="text-sm font-semibold">{title}</p>
          {detail ? <p className="text-muted-foreground truncate text-sm tabular-nums">{detail}</p> : null}
        </div>
        {action}
      </div>
    </li>
  )
}

/**
 * Today at a glance, above the lists it counts: overdue invoices, drafts that can go, and the next
 * moms deadline. It reads the same invoice rows and status rule as Fakturaer and the overdue card, so
 * its figures are theirs. It only shows; each row's one action opens where the work is done, and
 * nothing is sent from here. Hidden while loading and when there is nothing to do.
 */
export function MorningCard({ canSendReminders }: { canSendReminders: boolean }) {
  const { t, locale } = useI18n()
  const reminded = remindedInvoiceIds(useReminderJobs())
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const today = useCalendarDate(loaded?.settings?.timezone)

  const load = useCallback(async () => {
    try {
      const [list, settings] = await Promise.all([trpc.invoices.list.query(), trpc.settings.get.query().catch(() => null)])
      const invoices = list as unknown as DraftInvoice[]
      setLoaded({ invoices, settings: settings as MorningSettings | null, readyKeys: await readyKeysOf(invoices) })
    } catch {
      // The lists below report their own errors; the summary stays away rather than guess.
    }
  }, [])
  useQueryRefresh(["invoices", "settings"], () => { void load() })

  useEffect(() => {
    void load()
    // An invoice sent from the command bar changes every figure here.
    return onRequestDone(() => void load())
  }, [load])

  const model = useMemo(
    () => loaded && presentMorning({ ...loaded, reminded, today }),
    // `reminded` is a new set every render; its contents are what matter.
    [loaded, [...reminded].join(), today]
  )
  if (!model?.visible) return null

  const money = (totals: { currency: string; amount: number }[]) =>
    totals.map(({ currency, amount }) => formatCurrency(amount, currency, locale)).join(" · ")
  const { overdue, drafts, vat } = model
  const outline = "transition-[color,background-color,box-shadow]"
  const names = drafts.customers.slice(0, 2).join(" · ")
  const more = drafts.customers.length - 2

  return (
    <div className="@container -mt-2 mb-6">
      <ul
        aria-label={t("dashboard.morning.label")}
        data-testid="morning-card"
        className={cn("request-stagger border-hairline bg-panel grid divide-y overflow-hidden rounded-xl border @2xl:divide-x @2xl:divide-y-0", vat ? "@2xl:grid-cols-3" : "@2xl:grid-cols-2")}
      >
        {overdue.count > 0 ? (
          <Row
            index={0}
            icon={Clock}
            tone="bg-tone-danger/14 text-tone-danger"
            title={tCount(t, "dashboard.morning.overdue.title", overdue.count)}
            detail={tCount(t, "dashboard.morning.overdue.detail", overdue.oldestDays, { amount: money(overdue.totals) })}
            action={canSendReminders ? (
              <Button type="button" size="sm" variant="outline" className={outline}
                onClick={() => announceRequestOpen({ kind: "overdue", input: t("shell.request.title.overdue") })}>
                {t("reminders.batch.send", { count: overdue.batch })}
              </Button>
            ) : null}
          />
        ) : (
          <Row index={0} icon={Clock} tone="bg-tone-muted/14 text-tone-muted" title={t("dashboard.morning.overdue.empty")} />
        )}
        {drafts.count > 0 ? (
          <Row
            index={1}
            icon={Send}
            tone="bg-tone-info/14 text-tone-info"
            title={tCount(t, "dashboard.morning.drafts.title", drafts.count)}
            detail={t("dashboard.morning.drafts.detail", {
              customers: more > 0 ? t("dashboard.morning.drafts.more", { names, more }) : names,
              amount: money(drafts.totals),
            })}
            action={
              <Button asChild size="sm" variant="outline" className={outline}>
                <Link to="/invoices">{t("dashboard.morning.drafts.action")}</Link>
              </Button>
            }
          />
        ) : (
          <Row index={1} icon={Send} tone="bg-tone-muted/14 text-tone-muted" title={t("dashboard.morning.drafts.empty")} />
        )}
        {vat ? (
          <Row
            index={2}
            icon={Percent}
            tone="bg-tone-info/14 text-tone-info"
            title={vat.daysLeft === 0
              ? t("dashboard.morning.vat.today", { period: vat.label })
              : tCount(t, "dashboard.morning.vat.title", vat.daysLeft, { period: vat.label })}
            detail={t("dashboard.morning.vat.detail", { date: formatDate(`${vat.date}T00:00:00Z`, locale, "UTC", { dayFirst: true }) })}
          />
        ) : null}
      </ul>
    </div>
  )
}
