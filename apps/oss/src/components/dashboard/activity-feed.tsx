import { useI18n } from "../../lib/i18n/react"
import { cn } from "../../lib/utils"
import { listRowLinkClass } from "../kvit/list"
import { activityLabelKey, describeActivity } from "./activity-events"
import { DocLink, targetKind } from "./doc-link"
import { formatRelativeTime } from "./format-relative"
import { DashboardSection, SectionEmpty, sectionRowClass } from "./section"
import type { ActivityEvent } from "./summary-model"

/** Enough to see what moved lately; the documents themselves keep the full history. */
const LINES = 5

/**
 * A short, quiet feed of what happened to documents: what happened ("Faktura 2026-148 betalt"),
 * and under it for whom and when. A line about a document opens it.
 */
export function ActivityFeed({
  events,
  asOf,
  timezone,
  className,
}: {
  events: ActivityEvent[]
  asOf: string
  timezone: string
  className?: string
}) {
  const { t, locale } = useI18n()
  const lines = describeActivity(events).slice(0, LINES)

  return (
    <DashboardSection title={t("dashboard.activity.title")} data-slot="dashboard-activity" className={className}>
      {lines.length === 0 ? (
        <SectionEmpty>{t("dashboard.activity.empty")}</SectionEmpty>
      ) : (
        <ul>
          {lines.map((line) => {
            const target = targetKind(line.target)
            const label = t(activityLabelKey(line.kind, line.number !== null), { number: line.number ?? "" })
            return (
              <li key={line.id} className={cn(sectionRowClass, "py-2.5", !target && "hover:bg-transparent")}>
                <p className="truncate text-sm">
                  {target ? (
                    <DocLink kind={target.kind} id={target.id} className={listRowLinkClass}>
                      {label}
                    </DocLink>
                  ) : (
                    label
                  )}
                </p>
                <p className="text-muted-foreground flex gap-x-1.5 text-xs">
                  {line.customerName ? (
                    <>
                      <span className="truncate">{line.customerName}</span>
                      <span aria-hidden="true">·</span>
                    </>
                  ) : null}
                  <time dateTime={line.occurredAt} className="shrink-0">
                    {formatRelativeTime(line.occurredAt, asOf, locale, timezone)}
                  </time>
                </p>
              </li>
            )
          })}
        </ul>
      )}
    </DashboardSection>
  )
}
