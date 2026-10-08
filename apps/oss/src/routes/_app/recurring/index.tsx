import { createFileRoute, Link } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { Plus, Repeat } from "lucide-react"
import { trpc } from "../../../trpc/client"
import { formatCurrency } from "../../../lib/i18n/format"
import { useI18n } from "../../../lib/i18n/react"
import { Badge } from "../../../components/ui/badge"
import { Button } from "../../../components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table"
import {
  formatCadence,
  formatRunDate,
  invoiceStatusLabel,
  RecurringStatusBadge,
  type RecurringScheduleListItem,
} from "../../../components/recurring/recurring-format"
import { RecurringScheduleActions } from "../../../components/recurring/recurring-schedule-actions"
import { RecurringScheduleDialog } from "../../../components/recurring/recurring-schedule-dialog"
import { useRecurringCapabilities } from "../../../components/recurring/use-recurring-capabilities"

export const Route = createFileRoute("/_app/recurring/")({
  component: RecurringInvoicesPage,
})

type Message = { kind: "info" | "error"; text: string }

function RecurringInvoicesPage() {
  const { t, locale } = useI18n()
  const [schedules, setSchedules] = useState<RecurringScheduleListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const { canCreate, canUpdate } = useRecurringCapabilities()

  const load = useCallback(async () => {
    try {
      setSchedules(await trpc.recurring.list.query())
    } catch {
      // Auth and organization errors are handled by the app layout.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const newButton = canCreate ? (
    <Button onClick={() => setCreating(true)}>
      <Plus />
      {t("recurring.action.new")}
    </Button>
  ) : null

  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold">{t("recurring.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("recurring.description")}</p>
        </div>
        {newButton}
      </div>

      {message && (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={`mb-4 text-sm ${message.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {message.text}
        </p>
      )}

      {loading ? (
        <p className="text-muted-foreground">{t("recurring.loading")}</p>
      ) : schedules.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Repeat className="size-12 text-muted-foreground mb-4" />
          <h2 className="text-lg font-semibold mb-1">{t("recurring.empty.title")}</h2>
          <p className="text-muted-foreground mb-4">{t("recurring.empty.description")}</p>
          {newButton}
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("recurring.table.name")}</TableHead>
                <TableHead>{t("recurring.table.customer")}</TableHead>
                <TableHead>{t("recurring.table.cadence")}</TableHead>
                <TableHead className="text-right">{t("recurring.table.amount")}</TableHead>
                <TableHead>{t("recurring.table.nextRun")}</TableHead>
                <TableHead>{t("recurring.table.status")}</TableHead>
                <TableHead>{t("recurring.table.lastInvoice")}</TableHead>
                {canUpdate && <TableHead className="w-[60px]" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.map((schedule) => (
                <TableRow key={schedule.id}>
                  <TableCell className="font-medium">
                    <Link
                      to="/recurring/$scheduleId"
                      params={{ scheduleId: schedule.id }}
                      className="hover:underline"
                    >
                      {schedule.name}
                    </Link>
                    {schedule.autoSend && (
                      <Badge variant="outline" className="ml-2 font-normal">
                        {t("recurring.autoSendBadge")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{schedule.contact.name}</TableCell>
                  <TableCell>{formatCadence(t, schedule.intervalCount, schedule.intervalUnit)}</TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(schedule.subtotal, schedule.currency, locale)}
                  </TableCell>
                  <TableCell>
                    {schedule.status === "ended" ? "—" : formatRunDate(schedule.nextRunAt, locale)}
                  </TableCell>
                  <TableCell>
                    <RecurringStatusBadge status={schedule.status} />
                  </TableCell>
                  <TableCell>
                    {schedule.lastInvoice ? (
                      <Link
                        to="/invoices/$invoiceId"
                        params={{ invoiceId: schedule.lastInvoice.id }}
                        search={{ emailWarning: undefined }}
                        className="hover:underline"
                      >
                        {schedule.lastInvoice.number}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{t("recurring.none")}</span>
                    )}
                    {schedule.lastInvoice && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {invoiceStatusLabel(t, schedule.lastInvoice.status)}
                      </span>
                    )}
                  </TableCell>
                  {canUpdate && (
                    <TableCell>
                      <RecurringScheduleActions
                        schedule={schedule}
                        canUpdate={canUpdate}
                        onChanged={() => void load()}
                        onMessage={setMessage}
                      />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {canCreate && (
        <RecurringScheduleDialog open={creating} onOpenChange={setCreating} onSaved={() => void load()} />
      )}
    </div>
  )
}
