import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { trpc } from "../../trpc/client"
import { useI18n } from "../../lib/i18n/react"
import { formatCurrency } from "../../lib/i18n/format"
import { isBillable } from "../../domain/agreements/billing-rules"
import { Button } from "../ui/button"
import { Label } from "../ui/label"

type Agreement = Awaited<ReturnType<typeof trpc.agreements.get.query>>
export function InvoiceDeliverables({ agreement, onChanged }: { agreement: Agreement; onChanged: () => Promise<void> }) {
  const { t, locale } = useI18n()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [scheduleAsSale, setScheduleAsSale] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<{ saleInvoiceId?: string; prepaymentInvoiceId?: string } | null>(null)
  const billable = agreement.deliverables.filter(line => isBillable(agreement, line))
  const held = agreement.deliverables.filter(line => line.allocation.state !== "unbilled" && line.status !== "cancelled")
  async function create() {
    setBusy(true); setError(null)
    try {
      const result = await trpc.invoices.createFromDeliverables.mutate({ agreementId: agreement.id, deliverableIds: selected, scheduleAsSale })
      setDrafts(result); setOpen(false)
      await onChanged()
    } catch (failure) { setError(failure instanceof Error ? failure.message : t("agreements.error")) }
    finally { setBusy(false) }
  }
  return <section className="grid gap-3">
    <Button disabled={!billable.length || busy} onClick={() => { setSelected(billable.map(line => line.id)); setScheduleAsSale(false); setOpen(true) }}>{t("agreements.invoice")}</Button>
    {open && <div className="grid gap-3 rounded-md border p-4">
      <p>{t("agreements.selectBillable")}</p>
      {billable.map(line => <Label key={line.id} className="flex items-center gap-3">
        <input type="checkbox" checked={selected.includes(line.id)} disabled={busy} onChange={event => setSelected(ids => event.target.checked ? [...ids, line.id] : ids.filter(id => id !== line.id))} />
        {line.title} ({formatCurrency(line.lineGross, agreement.currency, locale)})
      </Label>)}
      {billable.some(line => line.isDeposit && selected.includes(line.id)) && <>
        <p className="text-sm text-muted-foreground">{t("agreements.prepaymentNotice")}</p>
        <Label className="flex items-start gap-3"><input type="checkbox" checked={scheduleAsSale} disabled={busy} onChange={event => setScheduleAsSale(event.target.checked)} />{t("agreements.scheduleAsSaleChoice")}</Label>
      </>}
      {held.length > 0 && <div className="grid gap-1 border-t pt-3 text-sm">
        <p className="font-medium">{t("agreements.allocation.unavailableHeading")}</p>
        {held.map(line => <p key={line.id} className="text-muted-foreground">
          {line.title}: {t(`agreements.billing.${line.allocation.state}`)}
          {line.allocation.holder && <> {t(line.allocation.state === "reserved" ? "agreements.allocation.heldBy" : "agreements.allocation.billedOn")} <Link className="underline" to="/invoices/$invoiceId" params={{ invoiceId: line.allocation.holder.invoiceId }}>{line.allocation.holder.number ?? t("invoices.number.draft")}</Link></>}
        </p>)}
      </div>}
      <p className="text-xs text-muted-foreground">{t("agreements.allocation.supportedSources")}</p>
      <div className="flex gap-2"><Button disabled={busy || !selected.length} onClick={() => void create()}>{t("agreements.createInvoices")}</Button><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>{t("agreements.cancel")}</Button></div>
    </div>}
    {drafts?.saleInvoiceId && <Link className="underline" to="/invoices/$invoiceId" params={{ invoiceId: drafts.saleInvoiceId }}>{t("agreements.openSaleInvoice")}</Link>}
    {drafts?.prepaymentInvoiceId && <><p>{t("agreements.prepaymentNotice")}</p><Link className="underline" to="/invoices/$invoiceId" params={{ invoiceId: drafts.prepaymentInvoiceId }}>{t("agreements.openPrepaymentInvoice")}</Link></>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </section>
}
