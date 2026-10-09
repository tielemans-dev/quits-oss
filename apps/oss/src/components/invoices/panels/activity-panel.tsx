import { OperationJournal } from "../../activity/operation-journal"
import { useEffect, useState } from "react"
import type { ActivityEntry } from "../../../lib/exports/activity"
import { useI18n } from "../../../lib/i18n/react"
import { trpc } from "../../../trpc/client"
import { ActivityList } from "../../activity/activity-list"
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card"
import type { InvoicePanelProps } from "./types"

/** The invoice's activity timeline, including related payments and credit notes. */
export function InvoiceActivityPanel({ invoice, onChanged }: InvoicePanelProps) {
  const { t } = useI18n()
  const [events, setEvents] = useState<ActivityEntry[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    trpc.activity.forDocument
      .query({ aggregateType: "invoice", aggregateId: invoice.id })
      .then((result) => {
        if (cancelled) return
        setEvents(result.events)
        setError(false)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
    // Reload when the invoice changes state (sent, paid, credited) so new events appear.
  }, [invoice.id, invoice.status, invoice.paymentStatus])

  return (
    <>
    <OperationJournal documentType="invoice" documentId={invoice.id} revision={`${invoice.status}:${invoice.paymentStatus}`} onChanged={() => void onChanged()} />
    <Card>
      <CardHeader>
        <CardTitle>{t("activity.panel.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-destructive">{t("activity.error")}</p>
        ) : events === null ? (
          <p className="text-sm text-muted-foreground">{t("activity.loading")}</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("activity.panel.empty")}</p>
        ) : (
          <ActivityList events={events} />
        )}
      </CardContent>
    </Card>
    </>
  )
}
