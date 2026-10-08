import { Link } from "@tanstack/react-router"

import { useI18n } from "../../lib/i18n/react"
import { Panel } from "../kvit/panel"
import {
  activityLabelKey,
  activityListFor,
  describeActivity,
  type ActivityLine,
} from "./activity-events"
import { DocLink, targetKind } from "./doc-link"
import { formatRelativeTime } from "./format-relative"
import type { ActivityEvent } from "./summary-model"

function ActivityLabel({ line, label }: { line: ActivityLine; label: string }) {
  const className = "hover:text-foreground min-w-0 truncate transition-colors"
  const target = targetKind(line.target)
  if (target) {
    return (
      <DocLink kind={target.kind} id={target.id} className={className}>
        {label}
      </DocLink>
    )
  }
  const list = line.count > 1 ? activityListFor(line.kind) : null
  if (list) {
    return (
      <Link to={`/${list}`} className={className}>
        {label}
      </Link>
    )
  }
  return <span className="min-w-0 truncate">{label}</span>
}

/**
 * A short, quiet feed of what happened to documents: one line each, a relative time, no avatars.
 * The events carry only a type and the document they are about, so a line names what happened and
 * links to the document; neighbouring events of one kind are merged into a count.
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
            <li key={line.id} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
              <span className="text-muted-foreground flex min-w-0 items-baseline gap-2.5">
                <span aria-hidden="true" className="bg-foreground/25 size-1.5 shrink-0 translate-y-[-1px] rounded-full" />
                <ActivityLabel
                  line={line}
                  label={t(activityLabelKey(line.kind, line.count), { count: line.count })}
                />
              </span>
              <time
                dateTime={line.occurredAt}
                className="text-muted-foreground/80 shrink-0 text-xs"
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
