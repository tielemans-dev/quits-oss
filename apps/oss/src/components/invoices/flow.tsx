import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react"
import { DURATION, EASE_ENTER, prefersReducedMotion } from "../../lib/motion"
import { Link } from "@tanstack/react-router"
import { useI18n } from "../../lib/i18n/react"
import { trpc } from "../../trpc/client"
import { Amount } from "../kvit/amount"
import { decimalFromNumber } from "../kvit/amount-format"
import { Button } from "../ui/button"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "../ui/dialog"
import { InvoiceActivityPanel } from "./panels/activity-panel"
import { InvoiceRemindersPanel } from "./panels/reminders-panel"
import { invoiceDisplayStatus } from "../../lib/payments/invoice-display-status"
import { StatusBadge } from "../status-badge"
import type { CreatedDocumentTarget } from "../../lib/create-and-send"

const Editor = lazy(() => import("../../routes/_app/invoices/new").then(module => ({ default: module.NewInvoicePage })))
export type InvoiceFlowKind = "invoice" | "recurring" | "link"

/** FLIP the shared surface after layout. A new transition finishes the previous one immediately. */
export function useInvoiceMorph(state: unknown, origin?: DOMRect) {
  const [element, ref] = useState<HTMLDivElement | null>(null)
  const previous = useRef<DOMRect | null>(null)
  useLayoutEffect(() => {
    if (!element) { previous.current = null; return }
    if (typeof element.animate !== "function") return
    const finish = () => [element, ...document.querySelectorAll(".invoice-fresh-row")].forEach(node => node.getAnimations().forEach(animation => animation.finish()))
    finish()
    const rect = element.getBoundingClientRect(), from = previous.current ?? origin
    previous.current = rect
    const reduced = prefersReducedMotion()
    element.animate(reduced || !from ? [{ opacity: 0 }, { opacity: 1 }] : [
      { transformOrigin: "top left", transform: `translate(${from.x - rect.x}px,${from.y - rect.y}px) scale(${from.width / rect.width},${from.height / rect.height})`, opacity: 0.6 },
      { transformOrigin: "top left", transform: "none", opacity: 1 },
    ], { duration: reduced ? DURATION.fade : DURATION.base, easing: EASE_ENTER })
    document.addEventListener("pointerdown", finish)
    document.addEventListener("keydown", finish)
    return () => { document.removeEventListener("pointerdown", finish); document.removeEventListener("keydown", finish) }
  }, [state, origin, element])
  return ref
}

export function InvoiceFlow({ open, origin, onClose, onComplete }: { origin?: DOMRect; open: boolean; onClose: () => void; onComplete: (target: CreatedDocumentTarget) => void }) {
  const { t } = useI18n()
  const [kind, setKind] = useState<InvoiceFlowKind | null>(null)
  const surface = useInvoiceMorph(kind, origin)
  return <Dialog open={open} onOpenChange={value => { if (!value) onClose() }}><DialogContent ref={surface} onCloseAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLButtonElement>("[data-invoice-create]")?.focus() }} className={`invoice-flow ${kind ? "invoice-flow-editor" : ""}`}>
    <DialogTitle className={kind ? "sr-only" : ""}>{t(kind ? "invoices.new.title" : "invoices.flow.pickerTitle")}</DialogTitle>
    <DialogDescription className="sr-only">{t("invoices.flow.composer")}</DialogDescription>
    {kind ? <Suspense fallback={<p>{t("invoices.loading")}</p>}><Editor kind={kind} onCancel={onClose} onComplete={onComplete} /></Suspense> : <div className="grid gap-2">{(["invoice", "recurring", "link"] as const).map(option => <Button key={option} variant="outline" className="justify-start" onClick={() => setKind(option)}>{t(`invoices.flow.${option}`)}</Button>)}</div>}
  </DialogContent></Dialog>
}

export function InvoiceDetailPanel({ id, origin, onClose, onChanged }: { origin?: DOMRect; id: string; onClose: () => void; onChanged?: () => void }) {
  const { t, locale } = useI18n()
  const [invoice, setInvoice] = useState<Awaited<ReturnType<typeof trpc.invoices.get.query>> | null>(null)
  const surface = useInvoiceMorph(id, origin)
  const [error, setError] = useState(false)
  useEffect(() => { let current = true; trpc.invoices.get.query({ id }).then(result => { if (current) setInvoice(result) }).catch(() => { if (current) setError(true) }); return () => { current = false } }, [id])
  const reload = async () => { setInvoice(await trpc.invoices.get.query({ id })); onChanged?.() }
  return <Dialog open onOpenChange={value => { if (!value) onClose() }}><DialogContent ref={surface} onCloseAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLAnchorElement>(`[data-invoice-id="${id}"] a`)?.focus() }} className="invoice-flow invoice-detail-panel">
    <DialogTitle>{invoice?.number ?? t("invoices.flow.detail")}</DialogTitle><DialogDescription>{invoice?.contact.name}</DialogDescription>
    {error ? <p role="alert">{t("invoiceValidation.unknown")}</p> : invoice ? <>
      <StatusBadge domain="invoice" status={invoiceDisplayStatus(invoice)} />
      <Amount value={decimalFromNumber(invoice.total, invoice.currency)} currency={invoice.currency} locale={locale} size="md" />
      <InvoiceActivityPanel invoice={{ ...invoice, dueDate: new Date(invoice.dueDate).toISOString() }} onChanged={reload} />
      <InvoiceRemindersPanel invoice={{ ...invoice, dueDate: new Date(invoice.dueDate).toISOString() }} onChanged={reload} locale={locale} />
      <Button variant="outline" asChild><Link to="/invoices/$invoiceId" params={{ invoiceId: id }} search={{ emailWarning: undefined }}>{t("invoices.flow.detail")}</Link></Button>
    </> : <p>{t("invoices.loading")}</p>}
  </DialogContent></Dialog>
}
