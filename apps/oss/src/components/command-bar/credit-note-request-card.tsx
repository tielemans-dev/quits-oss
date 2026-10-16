import { useEffect, useId, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { creditNoteIssueInputSchema } from "@quits/contracts/credit-notes"
import { buildCreditLines } from "../../lib/credit-notes/calculation"
import { formatCurrency } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { trpc } from "../../trpc/client"
import { creditNumber, peekCredit, readCredit } from "./request-data"
import type { CreditNoteAvailability } from "../credit-notes/types"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { announceRequestDone } from "./request-events"
import { stagger } from "./request-card-slot"
import type { RequestCardProps } from "./request-intent"

function draftToast(id: string, invoiceId: string, message: string, undo: string, failed: string) {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const close = () => { root.unmount(); host.remove() }
  function Toast() {
    const [pending, setPending] = useState(false)
    const [error, setError] = useState(false)
    useEffect(() => { if (pending || error) return; const timer = setTimeout(close, 8000); return () => clearTimeout(timer) }, [pending, error])
    return <div role="status" className="fixed bottom-4 right-4 z-[60] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl border bg-popover p-4 text-sm text-popover-foreground">
      <span>{error ? failed : message}</span>
      <Button disabled={pending} variant="outline" className="transition-[color,background-color,box-shadow]" onClick={() => {
        setPending(true)
        void trpc.creditNotes.discardDraft.mutate({ id }).then(() => { announceRequestDone({ kind: "creditNote", invoiceId }); close() }).catch(() => { setError(true); setPending(false) })
      }}>{undo}</Button>
    </div>
  }
  root.render(<Toast />)
}

export function CreditNoteRequestCard({ intent, onDismiss }: RequestCardProps) {
  const { t, locale } = useI18n()
  const fieldId = useId()
  const [data, setData] = useState<CreditNoteAvailability | null>(() => peekCredit(creditNumber(intent.input)) ?? null)
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [category, setCategory] = useState("quantity")
  const [reason, setReason] = useState("")
  const [error, setError] = useState(false)
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const request = useRef({ key: "", id: "" })
  useEffect(() => {
    let cancelled = false
    const number = creditNumber(intent.input)
    setData(peekCredit(number) ?? null); setError(false); setQuantities({})
    readCredit(number)
      .then(value => { if (!value) throw new Error("not_found"); if (!cancelled) setData(value) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [intent.input])
  const categories = ["quantity", "discount", "cancelled"] as const
  const categoryText = t(`creditNotes.request.reason.${category as typeof categories[number]}`)
  const selection = creditNoteIssueInputSchema.safeParse({
    invoiceId: data?.invoiceId, mode: Object.keys(quantities).length ? "lines" : "full", reason: [categoryText, reason.trim()].filter(Boolean).join(": "),
    lines: data?.availability.lines.filter(entry => !/^0(?:[.,]0{1,2})?$/.test(quantities[entry.line.id] ?? String(entry.remainingQuantity)))
      .map(entry => ({ invoiceItemId: entry.line.id, quantity: (quantities[entry.line.id] ?? String(entry.remainingQuantity)).replace(",", ".") })),
  })
  const preview = data && selection.success ? buildCreditLines({ availability: data.availability, selection: selection.data, taxRate: data.taxRate, amountDescription: t("creditNotes.amountDescription", { number: data.invoiceNumber ?? "" }) }) : null
  const money = (amount: number) => formatCurrency(-amount, data?.currency, locale)
  async function create() {
    if (busy.current || !selection.success || !preview?.ok) return
    busy.current = true; setPending(true); setError(false)
    const key = JSON.stringify(selection.data)
    if (request.current.key !== key) request.current = { key, id: crypto.randomUUID() }
    try {
      const draft = await trpc.creditNotes.createDraft.mutate({ selection: selection.data, clientRequestId: request.current.id })
      announceRequestDone({ kind: "creditNote", invoiceId: selection.data.invoiceId })
      draftToast(draft.id, selection.data.invoiceId, t("creditNotes.request.created", { number: draft.number }), t("creditNotes.request.undo"), t("creditNotes.error.generic"))
      onDismiss()
    } catch { setError(true) } finally { busy.current = false; setPending(false) }
  }
  return <div className="space-y-4 p-4">
    <div {...stagger(0)}><h2 className="font-semibold">{t("creditNotes.document")}</h2>
      {data && <p className="break-words text-sm text-muted-foreground">{data.invoiceNumber} · {data.customerName}</p>}
    </div>
    {!data && !error && <p role="status">{t("creditNotes.loading")}</p>}
    {data && <fieldset disabled={pending} className="space-y-4">
      <legend className="sr-only">{t("creditNotes.dialog.mode.lines")}</legend>
      <ul {...stagger(1)} className="max-h-56 divide-y overflow-y-auto text-sm">
        {data.availability.lines.map(entry => <li key={entry.line.id} className="flex items-center gap-3 py-2">
          <label className="min-w-0 flex-1 break-words" htmlFor={`${fieldId}-${entry.line.id}`}>{entry.line.description}</label>
          <Input id={`${fieldId}-${entry.line.id}`} inputMode="decimal" className="w-20 text-right tabular-nums" disabled={entry.remainingQuantity <= 0}
            value={quantities[entry.line.id] ?? String(entry.remainingQuantity)}
            onChange={e => setQuantities(previous => ({ ...previous, [entry.line.id]: e.target.value }))} />
          {(!preview?.ok || preview.lines.every(line => line.invoiceItemId)) && <span className="min-w-24 text-right tabular-nums">{money(preview?.ok ? preview.lines.find(line => line.invoiceItemId === entry.line.id)?.lineGross ?? 0 : 0)}</span>}
        </li>)}
      </ul>
      {preview?.ok && preview.lines.filter(line => !line.invoiceItemId).map((line, index) => <p key={index} className="flex justify-between gap-3 text-sm tabular-nums"><span>{line.description}</span><span>{money(line.lineGross)}</span></p>)}
      <div {...stagger(2)} className="grid gap-2 text-sm"><label htmlFor={`${fieldId}-category`}>{t("creditNotes.dialog.reason.label")}</label>
        <select id={`${fieldId}-category`} className="h-9 rounded-md border bg-background px-3" value={category} onChange={e => setCategory(e.target.value)}>
          {categories.map(value => <option key={value} value={value}>{t(`creditNotes.request.reason.${value}`)}</option>)}
        </select>
        <Input aria-label={t("creditNotes.request.optionalReason")} placeholder={t("creditNotes.request.optionalReason")} maxLength={450} value={reason} onChange={e => setReason(e.target.value)} />
      </div>
      {preview?.ok && <div className="space-y-1 text-sm tabular-nums">
        <div className="flex justify-between"><span>{t("pdf.subtotal")}</span><span>{money(preview.subtotalNet)}</span></div>
        <div className="flex justify-between"><span>{t("pdf.tax")}</span><span>{money(preview.totalTax)}</span></div>
      </div>}
      <div {...stagger(3)} className="flex justify-between border-t pt-3 font-semibold tabular-nums"><span>{t("creditNotes.dialog.preview")}</span><span>{money(preview?.ok ? preview.totalGross : 0)}</span></div>
      <p className="text-sm text-muted-foreground">{t("creditNotes.request.draftHint")}</p>
      {(!selection.success || (preview && !preview.ok)) && <p role="alert" className="text-sm text-destructive">{t("creditNotes.error.nothing_to_credit")}</p>}
    </fieldset>}
    {error && <p role="alert" className="text-sm text-destructive">{t("creditNotes.error.generic")}</p>}
    <div {...stagger(4)} className="flex justify-end gap-2">
      <Button variant="outline" disabled={pending} onClick={onDismiss} className="transition-[color,background-color,box-shadow]">{t("creditNotes.action.cancel")}</Button>
      <Button disabled={pending || !preview?.ok} onClick={() => void create()} className="transition-[color,background-color,box-shadow]">{t("creditNotes.action.create")}</Button>
    </div>
  </div>
}
