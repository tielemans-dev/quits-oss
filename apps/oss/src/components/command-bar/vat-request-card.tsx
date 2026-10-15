import { useEffect, useRef, useState } from "react"
import type { VatOverview } from "../../lib/exports/vat-overview"
import { formatDate } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { trpc } from "../../trpc/client"
import { exportVat } from "../jobs/reminder-jobs-store"
import { Amount } from "../kvit/amount"
import { Button } from "../ui/button"
import { stagger } from "./request-card-slot"
import type { RequestCardProps } from "./request-intent"
import { handOffToTracker } from "./tracker-handoff"

export function VatRequestCard({ onDismiss }: RequestCardProps) {
  const { t, locale } = useI18n()
  const [overview, setOverview] = useState<VatOverview | null>(null)
  const [error, setError] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const requestId = useRef(crypto.randomUUID())
  useEffect(() => {
    let cancelled = false
    trpc.exports.vatOverview.query().then(result => { if (!cancelled) setOverview(result) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [])
  function startExport() {
    if (!overview?.available || !root.current) return
    const from = overview.period.from
    handOffToTracker(root.current.closest("[data-slot=request-card-slot]")!.getBoundingClientRect(),
      () => exportVat(from, requestId.current),
      { failed: t("shell.request.vat.error"), retry: t("reminders.tracker.retry"), close: t("reminders.tracker.dismiss") })
    onDismiss()
  }
  return <div ref={root} className="space-y-4 p-4">
    <h2 {...stagger(0)} className="font-semibold">{t("shell.request.title.vat")}</h2>
    {!overview ? <p role={error ? "alert" : "status"} className="text-muted-foreground text-sm">{t(error ? "shell.request.vat.error" : "shell.request.vat.loading")}</p>
      : !overview.available ? <p className="text-muted-foreground text-sm">{t(`shell.request.vat.${overview.reason}`)}</p> : <>
        <p {...stagger(1)} className="text-muted-foreground text-sm">{overview.period.label} · {formatDate(overview.period.from, locale, "UTC")} – {formatDate(overview.period.to, locale, "UTC")}</p>
        <dl {...stagger(2)} className="space-y-3 text-sm tabular-nums">
          <div className="flex items-baseline justify-between gap-4"><dt>{t("shell.request.vat.output")}</dt><dd><Amount value={{ minor: BigInt(overview.outputVatMinor) }} currency="DKK" locale={locale} /></dd></div>
          <div className="flex items-baseline justify-between gap-4"><dt>{t("shell.request.vat.input")}</dt><dd>{t("shell.request.vat.unknown")}</dd></div>
          <div className="flex items-baseline justify-between gap-4 border-t pt-3 font-semibold"><dt>{t("shell.request.vat.payable")}</dt><dd>{t("shell.request.vat.unknown")}</dd></div>
        </dl>
        <p {...stagger(3)} className="text-sm">{t("shell.request.vat.deadline", { date: formatDate(overview.period.date, locale, "UTC") })}</p>
        <p className="text-muted-foreground text-sm">{t("shell.request.vat.notice")}</p>
      </>}
    <div {...stagger(4)} className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="outline" onClick={onDismiss} className="transition-[color,background-color,box-shadow]">{t("shell.request.dismiss")}</Button>
      {overview?.available && <Button type="button" onClick={startExport} className="transition-[color,background-color,box-shadow]">{t("shell.request.vat.export")}</Button>}
    </div>
  </div>
}
