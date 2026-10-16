import { useAppQuery } from "../../../hooks/use-query-refresh"
import { QueryError, QuerySkeleton } from "../../query-state"
import { useI18n } from "../../../lib/i18n/react"
import { trpc } from "../../../trpc/client"
import { ActivityList } from "../../activity/activity-list"
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card"
import type { InvoicePanelProps } from "./types"

/** The invoice's activity timeline, including related payments and credit notes. */
export function InvoiceActivityPanel({ invoice }: InvoicePanelProps) {
  const { t } = useI18n()
  const query = useAppQuery(["activity"], () => trpc.activity.forDocument.query({ aggregateType: "invoice", aggregateId: invoice.id }), [invoice.id])
  const events = query.data?.events ?? null

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("activity.panel.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {query.error ? (
          <QueryError error={query.error} retry={query.refresh} />
        ) : events === null ? (
          <QuerySkeleton />
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("activity.panel.empty")}</p>
        ) : (
          <ActivityList events={events} />
        )}
      </CardContent>
    </Card>
  )
}
