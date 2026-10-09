import { useI18n } from "../../lib/i18n/react"
import { Panel } from "../kvit/panel"
import {
  activityLabelKey,
  describeActivity,
  type ActivityLine,
} from "./activity-events"
import { DocLink, targetKind } from "./doc-link"
import { formatRelativeTime } from "./format-relative"
import type { ActivityEvent } from "./summary-model"

function ActivityLabel({ line, label }: { line: ActivityLine; label: string }) {
  const target = targetKind(line.target)
  if (target) {
    return (
      <DocLink kind={target.kind} id={target.id} className="hover:text-foreground block truncate transition-colors">
        {label}
      </DocLink>
    )
  }
  return <span className="block truncate">{label}</span>
}

/**
 * A short, quiet feed of what happened to documents: one line each, a relative time, no avatars.
 * A line says what happened to which document and for whom ("Faktura 2026-148 betalt" with "Nordlys
 * Studio" under it), and links to the document.
 */
export function ActivityFeed({
  events,
  asOf,
  timezone,
}: {
  events: ActivityEvent[]
  asOf: string
  timezone: string
}) {
  const { t, locale } = useI18n()
  const lines = describeActivity(events)

  return (
    <Panel label={t("dashboard.activity.title")} data-slot="dashboard-activity">
      {lines.length === 0 ? (
        <p className="text-muted-foreground px-4 pt-1 pb-5 text-sm">{t("dashboard.activity.empty")}</p>
      ) : (
        <ul className="px-4 pt-1 pb-3">
          {lines.map((line) => (
            <li key={line.id} className="flex items-start justify-between gap-3 py-1.5 text-sm">
              <span className="text-muted-foreground flex min-w-0 items-start gap-2.5">
                <span aria-hidden="true" className="bg-foreground/25 mt-[7px] size-1.5 shrink-0 rounded-full" />
                <span className="min-w-0">
                  <ActivityLabel
                    line={line}
                    label={t(activityLabelKey(line.kind, line.number !== null), { number: line.number ?? "" })}
                  />
                  {line.customerName ? (
                    <span className="text-muted-foreground/70 block truncate text-xs">{line.customerName}</span>
                  ) : null}
                </span>
              </span>
              <time
                dateTime={line.occurredAt}
                className="text-muted-foreground/80 shrink-0 pt-0.5 text-xs"
              >
                {formatRelativeTime(line.occurredAt, asOf, locale, timezone)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
