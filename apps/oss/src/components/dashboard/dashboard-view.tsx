import { useMemo } from "react"

import { useI18n } from "../../lib/i18n/react"
import { PageHeader } from "../kvit/page-header"
import { ActivityFeed } from "./activity-feed"
import { AttentionList } from "./attention-list"
import { formatLongDate, formatMonthName } from "./format-relative"
import { HeroCard } from "./hero-card"
import { IncomingList } from "./incoming-list"
import { ReceivedChart } from "./received-chart"
import {
  classifyDashboard,
  openInvoiceDrafts,
  localToday,
  presentChart,
  presentHero,
  type DashboardState,
  type Summary,
} from "./summary-model"
import { useReminders, type SendReminder } from "./use-reminders"
import { FirstRun, GettingStarted } from "./welcome"

/**
 * With money on the page the subtitle is the date, in the organization's time zone (the summary's
 * own, so server and browser agree), and repeats nothing the hero says. Before there is any, it
 * says what the page will become.
 */
export function dashboardSubtitle(
  state: DashboardState,
  summary: Summary,
  locale: string,
): string | null {
  return state === "active" || state === "kvit" ? formatLongDate(summary.asOf, locale, summary.timezone) : null
}

/** The title block, shared by the loaded page, the skeleton and the error. */
export function DashboardHeader({ subtitle }: { subtitle?: string }) {
  const { t } = useI18n()
  // A blank line keeps the height of the subtitle, so the page does not shift when it arrives.
  return <PageHeader title={t("nav.dashboard")} subtitle={subtitle ?? "\u00a0"} />
}

/**
 * The dashboard of a loaded summary. Three questions, in the order a person asks them: how much
 * money is on its way (the blue card), what needs me today (attention), and is it going well (the
 * rest). The layout answers to the width of the content, not the window, since the sidebar takes
 * a share of it: one column on a phone, two when there is room, and the full 3:2 grid from 56rem.
 */
export function DashboardView({
  summary,
  sendReminder,
  onRemindersSettled,
}: {
  summary: Summary
  sendReminder: SendReminder
  onRemindersSettled?: () => void
}) {
  const { t, locale } = useI18n()
  const state = classifyDashboard(summary)
  const { states: reminders, remind } = useReminders(sendReminder, onRemindersSettled)

  const hero = useMemo(() => presentHero(summary), [summary])
  const chart = useMemo(() => presentChart(summary), [summary])
  const drafts = useMemo(() => openInvoiceDrafts(summary), [summary])
  const today = localToday(summary.asOf, summary.timezone)
  const monthName = formatMonthName(summary.asOf, locale, summary.timezone)
  const inAttention = useMemo(
    () => new Set(summary.attention.map((item) => item.documentId)),
    [summary.attention]
  )

  return (
    <>
      <DashboardHeader subtitle={dashboardSubtitle(state, summary, locale) ?? t("dashboard.subtitle.start")} />

      {state === "first-run" ? (
        // A wrapper, because the page container strips the padding of its direct children.
        <div>
          <FirstRun />
        </div>
      ) : (
        <div className="@container" data-state={state}>
          {/*
            Two columns from 56rem: money on the left (the blue card, what needs me), the pipeline
            and the calm story on the right. Below that the columns dissolve (`contents`), so the
            cards are one flow in reading order: card, attention, incoming, chart, activity.
          */}
          <div className="grid gap-4 @2xl:grid-cols-2 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] @4xl:items-start">
            <div className="contents @4xl:flex @4xl:flex-col @4xl:gap-4">
              {state === "getting-started" ? (
                <GettingStarted
                  drafts={drafts}
                  className="@2xl:col-span-2 @4xl:col-span-1"
                />
              ) : (
                <HeroCard
                  hero={hero}
                  kvit={state === "kvit"}
                  monthName={monthName}
                  className="@2xl:col-span-2 @4xl:col-span-1"
                />
              )}
              {state !== "getting-started" || summary.attention.length > 0 ? (
                <AttentionList
                  items={summary.attention}
                  incoming={summary.incoming}
                  reminders={reminders}
                  onRemind={remind}
                />
              ) : null}
            </div>

            <div className="contents @4xl:flex @4xl:flex-col @4xl:gap-4">
              {state === "getting-started" ? (
                <ActivityFeed events={summary.activity} asOf={summary.asOf} timezone={summary.timezone} />
              ) : (
                <>
                  <IncomingList
                    items={summary.incoming}
                    today={today}
                    inAttention={inAttention}
                    reminders={reminders}
                    onRemind={remind}
                  />
                  <ReceivedChart chart={chart} streak={summary.streak} />
                  <ActivityFeed events={summary.activity} asOf={summary.asOf} timezone={summary.timezone} />
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
