import { useNavigate } from "@tanstack/react-router"
import { documentLineV2InputSchema, quantityDecimalSchema } from "@quits/contracts/invoices"
import { previewDraft } from "@quits/shared/pricing"
import { Check } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"

import { useInvoiceDueDate } from "../../hooks/use-invoice-due-date"
import { useOrgCurrency } from "../../hooks/use-org-currency"
import type { CatalogItemOption } from "../../lib/catalog"
import { formatCurrency, formatDate } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { defaultDocumentTaxRate } from "../../lib/invoice-defaults"
import { invoiceFieldIssues, invoiceIssueKey } from "../../lib/invoice-field-issues"
import { loadLastInvoice, type LastInvoice } from "../../lib/last-invoice"
import { localizeInvoiceQuantity, normalizeInvoiceQuantity } from "../../lib/invoice-quantity"
import { parseRequest, type RequestCustomer } from "../../lib/request-parser"
import { clearHandoff, handOff, readHandoff, type InvoiceHandoff } from "../../lib/request-handoff"
import { submitInvoice } from "../../lib/submit-invoice"
import { cn } from "../../lib/utils"
import { trpc } from "../../trpc/client"
import { initialIssuanceValues } from "../invoices/issuance-fields"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { holdSend } from "./held-send"
import { stagger } from "./request-card-slot"
import type { RequestCardProps } from "./request-intent"
import { announceRequestDone } from "./request-events"
import { MORPH_EASING, useMorph } from "./use-morph"

const SHRINK_MS = 400
const HOLD_MS = 1500
const LEAVE_MS = 250
/** The check's content arrives this long into the shrink, once the surface has made room. */
const CHECK_DELAY_MS = 90

type Readiness = Awaited<ReturnType<typeof trpc.invoices.sendReadiness.query>>

/**
 * The invoice a request describes, as a compact version of the new-invoice screen. The parser only
 * fills in what was said; moms, totals and the dates come from the same code the form uses. Nothing
 * is created until Send faktura is pressed, and that goes through the form's own create-and-send.
 */
export function InvoiceRequestCard({ intent, onDismiss }: RequestCardProps) {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const currency = useOrgCurrency()
  // Coming back from the form brings the edited invoice with it; otherwise the request is all there is.
  const [back] = useState(() => readHandoff("card"))
  useEffect(clearHandoff, [])
  const [ownDueDate] = useInvoiceDueDate()
  const dueDate = back?.dueDate || ownDueDate
  const [issuance] = useState(() => back?.issuance ?? initialIssuanceValues())
  const [known, setKnown] = useState<{ customers: RequestCustomer[]; catalogItems: CatalogItemOption[] } | null>(null)
  const [picked, setPicked] = useState("")
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState<{ id: string; amount: string; customer: string } | null>(null)
  const [leaving, setLeaving] = useState(false)
  const sending = useRef(false)
  const repeat = intent.kind === "repeat"
  // "Som sidst": the customer's last invoice, undefined while it loads and null when there is none.
  const [last, setLast] = useState<LastInvoice | null | undefined>()
  // The quantities as typed, by line; the one thing the card lets the person change.
  const [quantities, setQuantities] = useState<Record<number, string>>({})
  const hours = useRef<HTMLInputElement>(null)
  const announced = useRef<string | null>(null)
  const dismissRef = useRef(onDismiss)
  useEffect(() => { dismissRef.current = onDismiss })
  const morph = useMorph<HTMLDivElement>(SHRINK_MS)

  useEffect(() => {
    let cancelled = false
    Promise.all([trpc.contacts.list.query(), trpc.catalog.list.query().catch(() => [])])
      .then(([customers, catalogItems]) => { if (!cancelled) setKnown({ customers: customers as RequestCustomer[], catalogItems: catalogItems as CatalogItemOption[] }) })
      .catch(() => { if (!cancelled) setError(t("invoiceValidation.unknown")) })
    return () => { cancelled = true }
  }, [t])

  const draft = useMemo(() => known && parseRequest(intent.input, { customers: known.customers, catalogItems: known.catalogItems }), [known, intent.input])
  const match = draft?.customer
  const contactId = picked || back?.contactId || (match?.status === "matched" ? match.candidates[0]!.id : "")
  const customerName = known?.customers.find(customer => customer.id === contactId)?.name

  useEffect(() => {
    if (!known) return
    let cancelled = false
    trpc.invoices.sendReadiness.query({ contactId: contactId || undefined, currency })
      .then(state => { if (!cancelled) setReadiness(state) })
      .catch(() => { if (!cancelled) setError(t("invoiceValidation.unknown")) })
    return () => { cancelled = true }
  }, [known, contactId, currency, t])

  // Coming back from the form brings its own lines.
  useEffect(() => {
    if (!repeat || !contactId || back) return
    let cancelled = false
    setLast(undefined)
    loadLastInvoice(contactId, currency)
      .then(found => { if (!cancelled) setLast(found) })
      .catch(() => { if (!cancelled) setError(t("invoiceValidation.unknown")) })
    return () => { cancelled = true }
  }, [repeat, contactId, currency, back, t])
  // The hours field is where the person is expected to type, so it takes focus once the lines arrive.
  useEffect(() => { if (last) { hours.current?.focus({ preventScroll: true }); hours.current?.select() } }, [last])

  const parsed = draft?.items[0]
  const base: InvoiceHandoff["items"] = back?.items ?? (repeat ? last?.items ?? [] : parsed ? [{ description: (parsed.description || draft?.remainder || "").trim(), quantity: parsed.quantity ?? "1", unitPrice: parsed.unitPrice ?? "" }] : [])
  const items = base.map((item, index) => quantities[index] === undefined ? item : { ...item, quantity: quantities[index] })
  const lines = items.map(item => normalizeInvoiceQuantity(item, locale))
  const taxRate = back?.taxRate ?? (readiness ? defaultDocumentTaxRate(readiness) : "0")
  const pricesIncludeTax = back?.pricesIncludeTax ?? last?.pricesIncludeTax ?? (readiness && readiness.standardVatRate == null ? readiness.pricesIncludeTax : false)
  // The form's own arithmetic; the card never adds up a figure itself.
  const preview = previewDraft({ items: lines, taxRate, pricesIncludeTax, currency })
  const money = (value: string | number | undefined) => value === undefined || !preview.result || !readiness ? "—" : formatCurrency(Number(value), currency, locale)
  const total = money(preview.result?.gross)

  const gapIn = (item: InvoiceHandoff["items"][number]) =>
    !item.description.trim() || !documentLineV2InputSchema.shape.description.safeParse(item.description).success ? t("docForm.column.description")
    : !quantityDecimalSchema.safeParse(item.quantity).success ? t("docForm.column.qty")
    : !documentLineV2InputSchema.shape.unitPrice.safeParse(item.unitPrice).success ? t("docForm.column.unitPrice") : null
  const missing = !contactId ? t("docForm.contact")
    : !lines.length ? t("docForm.lineItems")
    : lines.map(gapIn).find(Boolean) ?? (!dueDate ? t("invoices.new.field.dueDate") : null)
  const foreign = !!readiness?.baseCurrency && readiness.baseCurrency !== currency
  const blocker = readiness?.issues[0]
  const blockedBy = missing ? t("shell.request.invoice.gap", { field: missing })
    : foreign ? t("shell.request.invoice.foreignCurrency")
    : blocker ? t(invoiceIssueKey(blocker.code), blocker.params) : null
  const note = error ?? (repeat && last === null && !back ? t("shell.request.repeat.none") : blockedBy)

  async function send() {
    if (sending.current || blockedBy) return
    sending.current = true
    setPending(true); setError(null)
    try {
      // The recipient version is read again at the click, as the form does, so the server can refuse a changed contact.
      const state = await trpc.invoices.sendReadiness.query({ contactId, currency })
      if (state.policyUnavailable || state.issues.length || !state.recipientVersion) {
        setError(state.policyUnavailable ? t("invoiceValidation.policyUnavailable") : state.issues[0] ? t(invoiceIssueKey(state.issues[0].code), state.issues[0].params) : t("invoiceValidation.unknown"))
        return
      }
      const reviewedRecipient = state.recipientVersion
      const submit = () => submitInvoice(
        { contactId, dueDate, taxRate, pricesIncludeTax, vatEvidence: back?.vatEvidence ?? {}, notes: back?.notes, issuance, currency, baseCurrency: state.baseCurrency, items: lines },
        { sendImmediately: true, reviewedRecipient, t }
      )
      // The draft exists; the invoice page tells what went wrong, as it does after the form.
      const showFailure = (target: Awaited<ReturnType<typeof submit>>) => {
        void navigate({ to: "/invoices/$invoiceId", params: { invoiceId: target.id }, search: { emailWarning: target.emailWarning, sendError: target.sendError } })
      }
      if (repeat) {
        // Fortryd needs time before anything is made: the click starts the wait, and the card is done.
        holdSend({
          customer: customerName ?? "",
          amount: total,
          run: async () => {
            const target = await submit()
            if (target.sendError || target.emailWarning) return showFailure(target)
            announceRequestDone({ kind: "invoice", invoiceId: target.id })
          },
        })
        onDismiss()
        return
      }
      const target = await submit()
      if (target.sendError || target.emailWarning) {
        showFailure(target)
        onDismiss()
        return
      }
      morph.run(() => setSent({ id: target.id, amount: total, customer: customerName ?? "" }))
    } catch (err) {
      const changed = invoiceFieldIssues(err).find(issue => issue.code === "changed_since_review")
      setError(changed ? t(invoiceIssueKey(changed.code), changed.params) : t("invoiceValidation.unknown"))
    } finally { sending.current = false; setPending(false) }
  }

  function edit() {
    handOff("form", {
      input: intent.input, contactId, dueDate, issuance, taxRate, pricesIncludeTax, vatEvidence: back?.vatEvidence ?? {}, notes: back?.notes ?? "",
      items: lines.map(item => ({ ...item, quantity: localizeInvoiceQuantity(item.quantity, locale) })),
    })
    void navigate({ to: "/invoices/new" })
    onDismiss()
  }

  // The dashboard behind learns of the new invoice when the check lets go; closing early still tells it.
  useEffect(() => {
    if (!sent) return
    const announce = () => {
      if (announced.current === sent.id) return
      announced.current = sent.id
      announceRequestDone({ kind: "invoice", invoiceId: sent.id })
    }
    const leave = setTimeout(() => { announce(); setLeaving(true) }, SHRINK_MS + HOLD_MS)
    const close = setTimeout(() => dismissRef.current(), SHRINK_MS + HOLD_MS + LEAVE_MS)
    return () => { clearTimeout(leave); clearTimeout(close); announce() }
  }, [sent])

  // The same element carries the card and the check, so the morph animates one surface and never a blank one.
  if (sent) {
    return (
      <div
        ref={morph.ref}
        role="status"
        className={cn("request-stagger flex items-center gap-3 overflow-hidden p-6", leaving && "scale-90 opacity-0 transition-[opacity,transform] motion-reduce:scale-100")}
        style={{ "--stagger-delay": `${CHECK_DELAY_MS}ms`, ...(leaving && { transitionDuration: `${LEAVE_MS}ms`, transitionTimingFunction: MORPH_EASING }) } as CSSProperties}
      >
        <span {...stagger(0)} className="bg-tone-success/15 text-tone-success flex size-9 shrink-0 items-center justify-center rounded-full">
          <Check className="size-5" aria-hidden="true" />
        </span>
        <div {...stagger(1)} className="min-w-0">
          <p className="font-semibold">{t("shell.request.invoice.sent")}</p>
          <p className="text-muted-foreground truncate text-sm tabular-nums">{[sent.amount, sent.customer].filter(Boolean).join(" · ")}</p>
        </div>
      </div>
    )
  }

  return (
    <div ref={morph.ref} className="space-y-4 overflow-hidden p-4">
      {repeat && (
        <div {...stagger(0)}>
          <p className="font-semibold">{t("shell.request.title.repeat")}</p>
          {last?.number && <p className="text-muted-foreground text-sm tabular-nums">{t("shell.request.repeat.copiedFrom", { number: last.number })}</p>}
        </div>
      )}
      <div {...stagger(0)} className="grid gap-1.5 text-sm">
        <span className="text-muted-foreground">{t("docForm.contact")}</span>
        {!known ? <span className="text-muted-foreground">{t("docForm.loadingContacts")}</span>
          : match?.status === "matched" || picked ? <span className="font-semibold">{customerName}</span>
          : (
            <Select value={picked} onValueChange={setPicked}>
              <SelectTrigger aria-label={t("docForm.contact")} className="w-full"><SelectValue placeholder={t("docForm.selectContact")} /></SelectTrigger>
              <SelectContent>{(match?.candidates.length ? match.candidates : known.customers).map(customer => <SelectItem key={customer.id} value={customer.id}>{customer.name}</SelectItem>)}</SelectContent>
            </Select>
          )}
      </div>
      {lines.map((line, index) => (
        <div key={index} {...stagger(1)} className="flex items-baseline justify-between gap-3 text-sm">
          <div className="min-w-0">
            <p className="truncate font-semibold">{line.description}</p>
            <p className="text-muted-foreground tabular-nums">
              {repeat ? (
                <Input
                  ref={index === 0 ? hours : undefined}
                  inputMode="decimal"
                  aria-label={t("shell.request.repeat.qty", { description: line.description })}
                  value={quantities[index] ?? localizeInvoiceQuantity(base[index]!.quantity, locale)}
                  onChange={event => { const typed = event.target.value; setQuantities(current => ({ ...current, [index]: typed })) }}
                  className={cn("mr-1 inline-block h-7 w-16 px-2 text-right tabular-nums", index === 0 && "border-ring ring-ring/50 ring-[3px]")}
                />
              ) : localizeInvoiceQuantity(line.quantity, locale)} × {line.unitPrice === "" ? "—" : formatCurrency(Number(line.unitPrice), currency, locale)}</p>
          </div>
          <span className="tabular-nums">{money(preview.result?.lines[index]?.[pricesIncludeTax ? "gross" : "net"])}</span>
        </div>
      ))}
      <dl {...stagger(2)} className="grid gap-1 border-t pt-3 text-sm tabular-nums">
        <div className="flex justify-between"><dt className="text-muted-foreground">{t("docForm.summary.subtotal")}</dt><dd>{money(preview.result?.net)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted-foreground">{t("docForm.summary.tax")}{readiness ? ` ${taxRate} %` : ""}</dt><dd>{money(preview.result?.tax)}</dd></div>
        <div className="flex justify-between font-semibold"><dt>{t("docForm.summary.total")}</dt><dd>{total}</dd></div>
      </dl>
      <p {...stagger(3)} className="text-muted-foreground text-sm">
        {t("invoices.new.field.dueDate")} {dueDate ? formatDate(dueDate, locale) : "—"} · {t("invoices.issuance.supplyDate")} {formatDate(issuance.supplyDate, locale)}
      </p>
      {note && <p role="alert" className="text-sm text-destructive">{note}</p>}
      <div {...stagger(4)} className="flex justify-end gap-2">
        {/* The shadcn default animates every property; name the ones that change. */}
        <Button type="button" variant="outline" onClick={onDismiss} disabled={pending} className="transition-[color,background-color,box-shadow]">{t("shell.request.dismiss")}</Button>
        <Button type="button" variant="outline" onClick={edit} disabled={pending || !readiness} className="transition-[color,background-color,box-shadow]">{t("shell.request.invoice.edit")}</Button>
        <Button type="button" disabled={pending || !readiness || !!blockedBy} onClick={() => void send()} className="transition-[color,background-color,box-shadow]">{pending ? t("invoices.detail.action.sending") : t("invoiceSend.confirm")}</Button>
      </div>
    </div>
  )
}
