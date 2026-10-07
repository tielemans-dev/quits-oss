import type { inferRouterOutputs } from "@trpc/server"
import type { AppRouter } from "../../trpc/router"
import { formatDate } from "../../lib/i18n/format"
import type { useI18n } from "../../lib/i18n/react"
import { Badge } from "../ui/badge"

type RouterOutputs = inferRouterOutputs<AppRouter>
export type RecurringScheduleListItem = RouterOutputs["recurring"]["list"][number]
export type RecurringScheduleDetail = RouterOutputs["recurring"]["get"]
export type RecurringStatus = RecurringScheduleListItem["status"]
export type RecurringIntervalUnit = RecurringScheduleListItem["intervalUnit"]

type Translate = ReturnType<typeof useI18n>["t"]

/** "Every month", "Every 2 weeks", ... */
export function formatCadence(t: Translate, intervalCount: number, intervalUnit: RecurringIntervalUnit) {
  const plural = intervalCount === 1 ? "one" : "other"
  return t(`recurring.cadence.${intervalUnit}.${plural}`, { count: intervalCount })
}

/** Run dates are calendar dates stored at UTC midnight; format them in UTC so they never shift. */
export function formatRunDate(date: Date | string, locale: string) {
  return formatDate(date, locale, "UTC", { month: "short" })
}

/** `YYYY-MM-DD` for date inputs. */
export function toCalendarDate(date: Date | string) {
  return new Date(date).toISOString().slice(0, 10)
}

const statusClassName: Record<RecurringStatus, string> = {
  active: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  paused: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  ended: "bg-muted text-muted-foreground",
}

export function RecurringStatusBadge({ status, t }: { status: RecurringStatus; t: Translate }) {
  return (
    <Badge variant="outline" className={statusClassName[status]}>
      {t(`recurring.status.${status}`)}
    </Badge>
  )
}

export function invoiceStatusLabel(t: Translate, status: string) {
  if (status === "sent") return t("invoices.status.sent")
  if (status === "paid") return t("invoices.status.paid")
  if (status === "overdue") return t("invoices.status.overdue")
  return t("invoices.status.draft")
}
