import { useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { trpc } from "../../trpc/client"
import { useI18n } from "../../lib/i18n/react"
import { formatCurrency } from "../../lib/i18n/format"
import { agreementLineAmounts } from "../../lib/agreements/offer-totals"
import { isBillable } from "../../domain/agreements/billing-rules"
import { Button } from "../ui/button"
import { Label } from "../ui/label"

type Agreement = Awaited<ReturnType<typeof trpc.agreements.get.query>>
export function InvoiceDeliverables({ agreement, depositsEnabled, onChanged }: { agreement: Agreement; depositsEnabled: boolean; onChanged: () => Promise<void> }) {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [scheduleAsSale, setScheduleAsSale] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<{ saleInvoiceId?: string; prepaymentInvoiceId?: string } | null>(null)
  const billable = agreement.deliverables.filter(line => isBillable(agreement, line) && (depositsEnabled || !line.isDeposit))
  const held = agreement.deliverables.filter(line => line.allocation.state !== "unbilled" && line.status !== "cancelled")
  // With nothing billable, say what has to happen first instead of only disabling the button.
  const waiting = agreement.deliverables.some(line => !line.isDeposit && line.status !== "cancelled" && line.billingStatus === "unbilled")
  const notReady = billable.length ? null
    : !waiting ? "agreements.invoice.nothingLeft"
    : agreement.billingTrigger === "on_delivery" ? "agreements.invoice.waitDelivery" : "agreements.invoice.waitAcceptance"
  async function create() {
    setBusy(true); setError(null)
    try {
      const result = await trpc.invoices.createFromDeliverables.mutate({ agreementId: agreement.id, deliverableIds: selected, scheduleAsSale })
      // A single draft opens at once. A sale and a prepayment draft together stay here, with a link to each.
      const only = result.saleInvoiceId && result.prepaymentInvoiceId ? undefined : result.saleInvoiceId ?? result.prepaymentInvoiceId
      if (only) return await navigate({ to: "/invoices/$invoiceId", params: { invoiceId: only } })
      setDrafts(result); setOpen(false)
      await onChanged()
    } catch (failure) { setError(failure instanceof Error ? failure.message : t("agreements.error")) }
    finally { setBusy(false) }
  }
  return <section className="grid gap-3">
    <Button className="justify-self-start" disabled={!billable.length || busy} aria-describedby={notReady ? "invoice-deliverables-not-ready" : undefined} onClick={() => { setSelected(billable.map(line => line.id)); setScheduleAsSale(false); setOpen(true) }}>{t("agreements.invoice")}</Button>
    {notReady && <p id="invoice-deliverables-not-ready" className="text-sm text-muted-foreground">{t(notReady)}</p>}
    {open && <div className="grid gap-3 rounded-md border p-4">
      <p>{t("agreements.selectBillable")}</p>
      {billable.map(line => <Label key={line.id} className="flex items-center gap-3">
        <input type="checkbox" checked={selected.includes(line.id)} disabled={busy} onChange={event => setSelected(ids => event.target.checked ? [...ids, line.id] : ids.filter(id => id !== line.id))} />
        {line.title} ({formatCurrency(agreementLineAmounts(agreement, line).amount, agreement.currency, locale)})
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
      <div className="flex gap-2"><Button disabled={busy || !selected.length} onClick={() => void create()}>{t(busy ? "agreements.creatingInvoices" : "agreements.createInvoices")}</Button><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>{t("agreements.cancel")}</Button></div>
    </div>}
    {drafts?.saleInvoiceId && <Link className="underline" to="/invoices/$invoiceId" params={{ invoiceId: drafts.saleInvoiceId }}>{t("agreements.openSaleInvoice")}</Link>}
    {drafts?.prepaymentInvoiceId && <><p>{t("agreements.prepaymentNotice")}</p><Link className="underline" to="/invoices/$invoiceId" params={{ invoiceId: drafts.prepaymentInvoiceId }}>{t("agreements.openPrepaymentInvoice")}</Link></>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </section>
}
