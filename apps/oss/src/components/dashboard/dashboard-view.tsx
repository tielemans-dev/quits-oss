import { useMemo, useRef, type ReactNode } from "react"

import { useI18n } from "../../lib/i18n/react"
import { ActivityFeed } from "./activity-feed"
import { AttentionList } from "./attention-list"
import { formatLongDate, formatMonthName } from "./format-relative"
import { firstName, greetingKey } from "./greeting"
import { HeroCard } from "./hero-card"
import { IncomingList } from "./incoming-list"
import { MurmurationSky } from "./murmuration-sky"
import { ReceivedChart } from "./received-chart"
import {
  classifyDashboard,
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

/**
 * The top of the Overblik: the greeting, the date and the command bar, centred under a sky with a
 * murmuration of starlings in it (sort sol). It reaches to the edges of the page column, and the
 * command bar unfolds over what follows, so nothing here clips it.
 */
export function DashboardHello({ title, subtitle, commandBar }: { title: ReactNode; subtitle?: string; commandBar?: ReactNode }) {
  const words = useRef<HTMLDivElement>(null)
  return (
    <section
      data-slot="dashboard-hello"
      className="relative -mx-(--gutter) -mt-8 mb-4 grid min-h-72 place-items-center px-(--gutter) py-12 sm:min-h-84"
    >
      <MurmurationSky clearRef={words} />
      <div ref={words} className="relative grid w-full max-w-160 justify-items-center">
        <header data-slot="page-header" className="text-center">
          <h1 className="text-2xl font-medium tracking-[-0.02em] text-balance sm:text-3xl">{title}</h1>
          {/* A blank line keeps the height of the date, so the page does not shift when it arrives. */}
          <p className="text-muted-foreground mt-1.5 text-sm">{subtitle ?? "\u00a0"}</p>
        </header>
        {commandBar ? <div className="mt-6 w-full">{commandBar}</div> : null}
      </div>
    </section>
  )
}

/** The top while the summary loads or failed: the sky and the command bar, the greeting to come. */
export function DashboardHeader({ commandBar }: { commandBar?: ReactNode }) {
  const { t } = useI18n()
  return <DashboardHello title={<><span className="sr-only">{t("nav.dashboard")}</span>{"\u00a0"}</>} commandBar={commandBar} />
}

/**
 * The dashboard of a loaded summary. Three questions, in the order a person asks them: what needs
 * me today (attention, most urgent first), how much money is on its way (Udestående), and is it
 * going well (the rest). The layout answers to the width of the content, not the window, since the
 * sidebar takes a share of it: one column on a phone, two when there is room, and the full 3:2
 * grid from 56rem.
 */
export function DashboardView({
  summary,
  readyCompany,
  sendReminder,
  sendReminderBatch,
  onRemindersSettled,
  userName,
  commandBar,
  newInvoiceId,
}: {
  summary: Summary
  readyCompany?: string
  /** Who the greeting addresses; without one it greets no one by name. */
  userName?: string | null
  /** The command bar, under the greeting. The page does not know how requests are answered. */
  commandBar?: ReactNode
  sendReminder: SendReminder
  /** Queues a reminder job for several invoices at once; the tracker toast follows it. */
  sendReminderBatch?: (invoiceIds: string[]) => Promise<unknown>
  onRemindersSettled?: () => void
  /** An invoice just sent from the command bar: its row arrives with a highlight that fades. */
  newInvoiceId?: string
}) {
  const { t, locale } = useI18n()
  const state = classifyDashboard(summary)
  const { states: reminders, remind } = useReminders(sendReminder, onRemindersSettled)

  const name = firstName(userName)
  const salutation = t(greetingKey(summary.asOf, summary.timezone))
  const greeting = name ? t("dashboard.greeting.named", { greeting: salutation, name }) : salutation

  const hero = useMemo(() => presentHero(summary), [summary])
  const chart = useMemo(() => presentChart(summary), [summary])
  const today = localToday(summary.asOf, summary.timezone)
  const monthName = formatMonthName(summary.asOf, locale, summary.timezone)
  const inAttention = useMemo(
    () => new Set(summary.attention.map((item) => item.documentId)),
    [summary.attention]
  )

  return (
    <>
      <DashboardHello
        title={greeting}
        subtitle={dashboardSubtitle(state, summary, locale) ?? t("dashboard.subtitle.start")}
        commandBar={commandBar}
      />

      {state === "first-run" ? (
        // A wrapper, because the page container strips the padding of its direct children.
        <div>
          <FirstRun readyCompany={readyCompany} />
        </div>
      ) : (
        <div className="@container" data-state={state}>
          {/*
            Two columns from 56rem: what needs me and the money owed on the left, the pipeline and
            the calm story on the right. Below that the columns dissolve (`contents`), so the
            sections are one flow in reading order: attention, Udestående, incoming, chart,
            activity. Sections sit on the page between hairlines, with no boxes.
          */}
          <div className="grid gap-10 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] @4xl:items-start @4xl:gap-x-12">
            <div className="contents @4xl:flex @4xl:flex-col @4xl:gap-10">
              {state !== "getting-started" || summary.attention.length > 0 ? (
                <AttentionList
                  items={summary.attention}
                  reminders={reminders}
                  onRemind={remind}
                  onRemindAll={
                    sendReminderBatch
                      ? (ids) => void sendReminderBatch(ids).catch(() => {}).finally(() => onRemindersSettled?.())
                      : undefined
                  }
                />
              ) : null}
              {state === "getting-started" ? (
                <GettingStarted drafts={summary.drafts} />
              ) : (
                <HeroCard hero={hero} kvit={state === "kvit"} monthName={monthName} />
              )}
            </div>

            <div className="contents @4xl:flex @4xl:flex-col @4xl:gap-10">
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
                    newInvoiceId={newInvoiceId}
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
