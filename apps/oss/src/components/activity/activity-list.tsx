import { Bot, Cog, User } from "lucide-react"
import type { ActivityEntry } from "../../lib/exports/activity"
import { aggregateLabel, describeActivity } from "../../lib/exports/activity-description"
import { normalizeLocale } from "../../lib/i18n/locale"
import { useI18n } from "../../lib/i18n/react"
import { Badge } from "../ui/badge"

type ActivityListProps = {
  events: ActivityEntry[]
  /** Show which kind of record each event belongs to (for the organization-wide log). */
  showAggregate?: boolean
}

function formatTimestamp(value: string, locale: string) {
  return new Intl.DateTimeFormat(normalizeLocale(locale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function ActorLine({ event }: { event: ActivityEntry }) {
  const { t } = useI18n()
  const { actor } = event

  if (actor.kind === "agent") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Badge variant="secondary">
          <Bot />
          {t("activity.actor.agent")}
        </Badge>
        <span>{actor.label ?? t("activity.actor.unknown")}</span>
      </span>
    )
  }
  if (actor.kind === "system") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Cog className="size-3.5" aria-hidden />
        <span>{actor.label ?? t("activity.actor.system")}</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <User className="size-3.5" aria-hidden />
      <span>{actor.name ?? actor.label ?? t("activity.actor.unknown")}</span>
    </span>
  )
}

/** A timeline of domain events: what happened, who did it, who approved it, and when. */
export function ActivityList({ events, showAggregate = false }: ActivityListProps) {
  const { t, locale } = useI18n()

  return (
    <ol className="grid gap-3">
      {events.map((event) => (
        <li key={event.sequence} className="flex gap-3">
          <span className="mt-2 size-2 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
          <div className="grid gap-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {showAggregate ? (
                <Badge variant="outline">{aggregateLabel(event.aggregateType, t)}</Badge>
              ) : null}
              <span className="break-words">{describeActivity(event, t)}</span>
            </div>
            {event.type.startsWith("settlement.") ? <div className="grid gap-1 text-sm">
              {([['reason', 'evidence'], ['feeReason', 'feeEvidence'], ['exchangeReason', 'exchangeEvidence']] as const).map(([reasonKey, evidenceKey]) => {
                const reason = event.payload[reasonKey]
                const evidence = event.payload[evidenceKey]
                return typeof reason === "string" && typeof evidence === "string" && /^https?:\/\//.test(evidence)
                  ? <a key={evidenceKey} href={evidence} target="_blank" rel="noreferrer" className="break-words underline">{reason}</a> : null
              })}
            </div> : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <ActorLine event={event} />
              {event.approvedBy ? (
                <span>
                  {t("activity.approvedBy", {
                    name: event.approvedBy.name ?? t("activity.actor.unknown"),
                  })}
                </span>
              ) : null}
              <time dateTime={event.occurredAt}>{formatTimestamp(event.occurredAt, locale)}</time>
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}
