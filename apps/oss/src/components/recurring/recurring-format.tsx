import type { inferRouterOutputs } from "@trpc/server"
import type { AppRouter } from "../../trpc/router"
import { formatDate } from "../../lib/i18n/format"
import type { useI18n } from "../../lib/i18n/react"
import { getStatusLabel } from "../../lib/status-tones"
import { StatusBadge } from "../status-badge"

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

export function RecurringStatusBadge({ status }: { status: RecurringStatus }) {
  return <StatusBadge domain="recurring" status={status} />
}

/** The label of an invoice status, for the invoices a schedule has made. */
export function invoiceStatusLabel(t: Translate, status: string) {
  return getStatusLabel(t, "invoice", status)
}
