import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { trpc } from "../../trpc/client"
import { useI18n } from "../../lib/i18n/react"
import { StatusBadge } from "../status-badge"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "../ui/alert-dialog"

type Agreement = Awaited<ReturnType<typeof trpc.agreements.get.query>>
type Line = Agreement["deliverables"][number]
type Capabilities = Awaited<ReturnType<typeof trpc.agreements.capabilities.query>>

/** Why a piece of work is, or is not, available to bill, with the actions its holder allows. */
export function DeliverableAllocation({ agreement, line, capabilities, onChanged, onError }: {
  agreement: Agreement; line: Line; capabilities: Capabilities; onChanged: () => Promise<void>; onError: (message: string | null) => void
}) {
  const { t } = useI18n()
  const { allocation } = line
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState("")
  async function run(action: () => Promise<unknown>) {
    setBusy(true); onError(null)
    try { await action(); setReason(""); await onChanged() }
    catch (failure) { onError(failure instanceof Error ? failure.message : t("agreements.error")) }
    finally { setBusy(false) }
  }
  const holder = allocation.holder
  const holderName = holder ? (holder.number ?? t("invoices.number.draft")) : null
  const holderLink = holder && <Link className="underline" to="/invoices/$invoiceId" params={{ invoiceId: holder.invoiceId }}>{holderName}</Link>
  const creditNote = allocation.creditNotes[0]
  return (
    <div className="grid gap-2" data-allocation-state={allocation.state}>
      <StatusBadge domain="billableAllocation" status={allocation.state} />
      {allocation.state === "reserved" && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <p>{holder ? t("agreements.allocation.heldBy") : t("agreements.allocation.heldHidden")} {holderLink}</p>
          {holder && capabilities.releaseReservation && (
            <AlertDialog>
              <AlertDialogTrigger asChild><Button variant="outline" size="sm" disabled={busy}>{t("agreements.allocation.release")}</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("agreements.allocation.release")}</AlertDialogTitle>
                  <AlertDialogDescription>{t("agreements.allocation.releaseConfirm", { title: line.title, invoice: holderName ?? "" })}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("agreements.cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void run(() => trpc.agreements.releaseReservation.mutate({ agreementId: agreement.id, deliverableId: line.id }))}>{t("agreements.allocation.release")}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      )}
      {(allocation.state === "invoiced" || allocation.state === "partially_credited" || allocation.state === "credited") && (
        <div className="grid gap-1 text-sm">
          {holder && <p>{t("agreements.allocation.billedOn")} {holderLink}</p>}
          {allocation.state === "partially_credited" && <p>{t("agreements.allocation.partialCredit", { credited: allocation.creditedQuantity, quantity: allocation.quantity })}</p>}
          {allocation.state !== "invoiced" && <p className="text-muted-foreground">{t("agreements.allocation.creditDoesNotRelease")}</p>}
          {allocation.invoiceHasUntiedCredit && <p className="text-muted-foreground">{t("agreements.allocation.untiedCredit")}</p>}
          {allocation.state === "credited" && capabilities.authorizeRebill && creditNote && (
            <AlertDialog>
              <AlertDialogTrigger asChild><Button variant="outline" size="sm" className="w-fit" disabled={busy}>{t("agreements.allocation.allowRebill")}</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("agreements.allocation.allowRebill")}</AlertDialogTitle>
                  <AlertDialogDescription>{t("agreements.allocation.rebillConfirm", { title: line.title, creditNote: creditNote.number })}</AlertDialogDescription>
                </AlertDialogHeader>
                <label className="grid gap-1 text-sm">
                  {t("agreements.allocation.rebillReason")}
                  <Textarea value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} />
                </label>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("agreements.cancel")}</AlertDialogCancel>
                  <AlertDialogAction disabled={reason.trim().length < 3} onClick={() => void run(() => trpc.agreements.authorizeRebill.mutate({ agreementId: agreement.id, deliverableId: line.id, creditNoteId: creditNote.id, reason: reason.trim() }))}>{t("agreements.allocation.allowRebill")}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      )}
      {allocation.rebills.length > 0 && (
        <ul className="grid gap-1 text-sm text-muted-foreground">
          {allocation.rebills.map(rebill => (
            <li key={rebill.generation}>{t("agreements.allocation.rebillRecord", { generation: rebill.generation, invoice: rebill.priorInvoiceNumber ?? t("agreements.allocation.anInvoice"), creditNote: rebill.creditNoteNumber ?? t("agreements.allocation.aCreditNote"), reason: rebill.reason })}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
