import { createFileRoute, Link } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, ArrowLeft } from "lucide-react"
import { trpc } from "../../../trpc/client"
import { formatCurrency } from "../../../lib/i18n/format"
import { useI18n } from "../../../lib/i18n/react"
import { Badge } from "../../../components/ui/badge"
import { Button } from "../../../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card"
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
  type RecurringScheduleDetail,
} from "../../../components/recurring/recurring-format"
import { RecurringScheduleActions } from "../../../components/recurring/recurring-schedule-actions"
import { useRecurringCapabilities } from "../../../components/recurring/use-recurring-capabilities"

export const Route = createFileRoute("/_app/recurring/$scheduleId")({
  component: RecurringSchedulePage,
})

type Message = { kind: "info" | "error"; text: string }

function RecurringSchedulePage() {
  const { t, locale } = useI18n()
  const { scheduleId } = Route.useParams()
  const [schedule, setSchedule] = useState<RecurringScheduleDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const { canUpdate } = useRecurringCapabilities()

  const load = useCallback(async () => {
    try {
      setSchedule(await trpc.recurring.get.query({ id: scheduleId }))
    } catch {
      setNotFound(true)
    } finally {
      setLoading(false)
    }
  }, [scheduleId])

  useEffect(() => {
    void load()
  }, [load])

  const backLink = (
    <Button variant="ghost" size="sm" asChild className="mb-4 -ml-2">
      <Link to="/recurring">
        <ArrowLeft className="size-4" />
        {t("recurring.action.back")}
      </Link>
    </Button>
  )

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">{t("recurring.loading")}</p>
      </div>
    )
  }

  if (notFound || !schedule) {
    return (
      <div className="p-6">
        {backLink}
        <p className="text-muted-foreground">{t("recurring.detail.notFound")}</p>
      </div>
    )
  }

  const taxAmount = (schedule.subtotal * schedule.taxRate) / 100
  const endDescription = schedule.endsAt
    ? t("recurring.detail.endsAt", { date: formatRunDate(schedule.endsAt, locale) })
    : schedule.remainingRuns !== null
      ? t("recurring.detail.remainingRuns", { count: schedule.remainingRuns })
      : t("recurring.detail.noEnd")

  return (
    <div className="p-6 max-w-5xl">
      {backLink}

      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{schedule.name}</h1>
            <RecurringStatusBadge status={schedule.status} t={t} />
            {schedule.autoSend && <Badge variant="outline">{t("recurring.autoSendBadge")}</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">
            {schedule.contact.name} · {formatCadence(t, schedule.intervalCount, schedule.intervalUnit)}
          </p>
        </div>
        <RecurringScheduleActions
          schedule={schedule}
          canUpdate={canUpdate}
          variant="buttons"
          onChanged={() => void load()}
          onMessage={setMessage}
        />
      </div>

      {message && (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={`mb-4 text-sm ${message.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {message.text}
        </p>
      )}

      {schedule.lastProblem && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <AlertTriangle className="size-4 mt-0.5 shrink-0" />
          <span>
            {formatRunDate(schedule.lastProblem.occurredAt, locale)}:{" "}
            {t(
              schedule.lastProblem.type === "recurring.run_failed"
                ? "recurring.detail.problem.runFailed"
                : "recurring.detail.problem.autoSendFailed",
              { message: schedule.lastProblem.message }
            )}
          </span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 mb-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("recurring.detail.schedule")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("recurring.table.nextRun")}</span>
              <span>{schedule.status === "ended" ? "—" : formatRunDate(schedule.nextRunAt, locale)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("recurring.detail.startDate")}</span>
              <span>{formatRunDate(schedule.startDate, locale)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("recurring.detail.lastRun")}</span>
              <span>{schedule.lastRunAt ? formatRunDate(schedule.lastRunAt, locale) : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("recurring.form.end")}</span>
              <span>{endDescription}</span>
            </div>
            <p className="text-muted-foreground">
              {t("recurring.detail.dueInDays", { count: schedule.dueInDays })}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("recurring.detail.template")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {schedule.items.map((item, index) => (
              <div key={index} className="flex justify-between gap-4">
                <span>
                  {item.quantity} × {item.description}
                </span>
                <span>{formatCurrency(schedule.lineTotals[index] ?? 0, schedule.currency, locale)}</span>
              </div>
            ))}
            <div className="flex justify-between text-muted-foreground border-t pt-2">
              <span>{t("recurring.detail.taxRate", { rate: schedule.taxRate })}</span>
              <span>{formatCurrency(taxAmount, schedule.currency, locale)}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>{t("docForm.summary.total")}</span>
              <span>{formatCurrency(schedule.subtotal + taxAmount, schedule.currency, locale)}</span>
            </div>
            {schedule.notes && <p className="text-muted-foreground whitespace-pre-line">{schedule.notes}</p>}
          </CardContent>
        </Card>
      </div>

      <h2 className="text-lg font-semibold mb-3">{t("recurring.detail.invoices")}</h2>
      {schedule.invoices.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("recurring.detail.noInvoices")}</p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("invoices.table.number")}</TableHead>
                <TableHead>{t("recurring.detail.runDate")}</TableHead>
                <TableHead>{t("invoices.table.dueDate")}</TableHead>
                <TableHead className="text-right">{t("invoices.table.total")}</TableHead>
                <TableHead>{t("invoices.table.status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedule.invoices.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell className="font-medium">
                    <Link
                      to="/invoices/$invoiceId"
                      params={{ invoiceId: invoice.id }}
                      search={{ emailWarning: undefined }}
                      className="hover:underline"
                    >
                      {invoice.number}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {invoice.recurringRunDate ? formatRunDate(invoice.recurringRunDate, locale) : "—"}
                  </TableCell>
                  <TableCell>{formatRunDate(invoice.dueDate, locale)}</TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(invoice.total, invoice.currency, locale)}
                  </TableCell>
                  <TableCell>
                    {invoiceStatusLabel(t, invoice.status)}
                    {invoice.status === "draft" && invoice.lastEmailAttemptOutcome === "failed" && (
                      <span
                        className="ml-2 text-xs text-destructive"
                        title={invoice.lastEmailAttemptMessage ?? undefined}
                      >
                        <AlertTriangle className="inline size-3" />
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
