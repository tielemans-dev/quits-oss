import { useEffect, useId, useRef, useState } from "react"
import type { VatOverview } from "../../lib/exports/vat-overview"
import { formatDate } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { trpc } from "../../trpc/client"
import { exportVat } from "../jobs/reminder-jobs-store"
import { Amount } from "../kvit/amount"
import { minorToDecimal } from "../kvit/amount-format"
import { useShellPermissions } from "../shell/use-shell-permissions"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { stagger } from "./request-card-slot"
import type { RequestCardProps } from "./request-intent"
import { handOffToTracker } from "./tracker-handoff"

export function VatRequestCard({ onDismiss }: RequestCardProps) {
  const { t, locale } = useI18n()
  const { can } = useShellPermissions()
  const inputId = useId()
  const [overview, setOverview] = useState<VatOverview | null>(null)
  const [error, setError] = useState(false)
  const [editing, setEditing] = useState(false)
  const [amount, setAmount] = useState("")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const purchaseInput = useRef<HTMLInputElement>(null)
  const requestId = useRef(crypto.randomUUID())
  useEffect(() => {
    let cancelled = false
    trpc.exports.vatOverview.query().then(result => { if (!cancelled) setOverview(result) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [])
  async function savePurchaseVat(value: string | null) {
    if (!overview?.available || saving) return
    setSaving(true); setSaveError(false)
    try {
      const result = await trpc.exports.setPurchaseVat.mutate({ from: overview.period.from, to: overview.period.to, amount: value })
      setOverview(result); setEditing(false); requestId.current = crypto.randomUUID()
    } catch { setSaveError(true) }
    finally { setSaving(false) }
  }
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
          <div className="flex items-baseline justify-between gap-4"><dt>{t("shell.request.vat.input")}</dt><dd>{overview.inputVatMinor == null ? t("shell.request.vat.unknown") : <Amount value={{ minor: BigInt(overview.inputVatMinor) }} currency="DKK" locale={locale} />}</dd></div>
          <div className="flex items-baseline justify-between gap-4 border-t pt-3 font-semibold"><dt>{t("shell.request.vat.payable")}</dt><dd>{overview.payableVatMinor == null ? t("shell.request.vat.unknown") : <Amount value={{ minor: BigInt(overview.payableVatMinor) }} currency="DKK" locale={locale} />}</dd></div>
        </dl>
        {can("settings:update") && (editing ? <div className="space-y-2">
          <Label htmlFor={inputId}>{t("shell.request.vat.entry")}</Label>
          <Input ref={purchaseInput} id={inputId} autoFocus inputMode="decimal" required pattern="[0-9]{1,16}([,.][0-9]{1,2})?" maxLength={19}
            title={t("shell.request.vat.validation")} value={amount} onChange={event => setAmount(event.target.value)} disabled={saving}
            onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); if (event.currentTarget.reportValidity()) void savePurchaseVat(amount) } }} />
          <p className="text-muted-foreground text-sm">{t("shell.request.vat.validation")}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={saving} onClick={() => { if (purchaseInput.current?.reportValidity()) void savePurchaseVat(amount) }}>{t(saving ? "shell.request.vat.saving" : "shell.request.vat.save")}</Button>
            <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => { setEditing(false); setSaveError(false) }}>{t("shell.request.vat.cancel")}</Button>
            {overview.inputVatMinor != null && <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => void savePurchaseVat(null)}>{t("shell.request.vat.clear")}</Button>}
          </div>
        </div> : <Button type="button" variant="outline" size="sm" onClick={() => {
          setAmount(overview.inputVatMinor == null ? "" : minorToDecimal(BigInt(overview.inputVatMinor), 2).replace(".", ","))
          setSaveError(false); setEditing(true)
        }}>{t(overview.inputVatMinor == null ? "shell.request.vat.add" : "shell.request.vat.edit")}</Button>)}
        {saveError && <p role="alert" className="text-destructive text-sm">{t("shell.request.vat.saveError")}</p>}
        {overview.inputVatUpdatedAt && <p role="status" className="text-muted-foreground text-sm">{t("shell.request.vat.updated", { date: formatDate(overview.inputVatUpdatedAt, locale) })}</p>}
        {overview.payableVatMinor?.startsWith("-") && <p className="text-sm">{t("shell.request.vat.refund")}</p>}
        <p {...stagger(3)} className="text-sm">{t("shell.request.vat.deadline", { date: formatDate(overview.period.date, locale, "UTC") })}</p>
        <p className="text-muted-foreground text-sm">{t(overview.inputVatMinor == null ? "shell.request.vat.notice" : "shell.request.vat.manualNotice")}</p>
      </>}
    <div {...stagger(4)} className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="outline" onClick={onDismiss} className="transition-[color,background-color,box-shadow]">{t("shell.request.dismiss")}</Button>
      {overview?.available && <Button type="button" disabled={editing || saving} onClick={startExport} className="transition-[color,background-color,box-shadow]">{t("shell.request.vat.export")}</Button>}
    </div>
  </div>
}
