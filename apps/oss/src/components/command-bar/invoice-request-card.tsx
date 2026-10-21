import { useNavigate } from "@tanstack/react-router"
import { documentLineV2InputSchema, quantityDecimalSchema } from "@quits/contracts/invoices"
import { previewDraft } from "@quits/shared/pricing"
import { Check, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"

import { useInvoiceDueDate } from "../../hooks/use-invoice-due-date"
import { useLearnedPaymentTerms } from "../../hooks/use-learned-payment-terms"
import { useOrgCurrencyState } from "../../hooks/use-org-currency"
import type { CatalogItemOption } from "../../lib/catalog"
import { formatCurrency, formatDate } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { defaultDocumentTaxRate } from "../../lib/invoice-defaults"
import { invoiceFieldIssues, invoiceIssueKey } from "../../lib/invoice-field-issues"
import { loadLastInvoice, type LastInvoice } from "../../lib/last-invoice"
import { localizeInvoiceQuantity, normalizeInvoiceQuantity } from "../../lib/invoice-quantity"
import { DURATION, EASE_ENTER } from "../../lib/motion"
import { parseRequest, type RequestCustomer } from "../../lib/request-parser"
import { clearHandoff, handOff, readHandoff, type InvoiceHandoff } from "../../lib/request-handoff"
import { submitInvoice } from "../../lib/submit-invoice"
import { cn } from "../../lib/utils"
import { trpc } from "../../trpc/client"
import { customersKey, peekRequestData, readCustomers } from "./request-data"
import { tCount } from "../dashboard/i18n"
import { initialIssuanceValues } from "../invoices/issuance-fields"
import { LocalizedDateField } from "../localized-date-field"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { syncHeldJobs } from "../undo/undo-store"
import { previewRequest } from "./request-preview"
import { stagger } from "./request-card-slot"
import type { RequestCardProps } from "./request-intent"

const SHRINK_MS = DURATION.card
const HOLD_MS = 1500
const LEAVE_MS = DURATION.leave
/** The check's content arrives this long into the shrink, once the surface has made room. */
const CHECK_DELAY_MS = DURATION.listFade

type Readiness = Awaited<ReturnType<typeof trpc.invoices.sendReadiness.query>>

/**
 * The invoice a request describes, as a compact version of the new-invoice screen. The parser only
 * fills in what was said; moms, totals and the dates come from the same code the form uses. Nothing
 * is created until Send faktura is pressed, and that goes through the form's own create-and-send.
 */
export function InvoiceRequestCard({ intent, onDismiss, initialContactId }: RequestCardProps & { initialContactId?: string }) {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const { currency, loaded: currencyLoaded } = useOrgCurrencyState()
  // Coming back from the form brings the edited invoice with it; otherwise the request is all there is.
  const [back] = useState(() => readHandoff("card"))
  useEffect(clearHandoff, [])
  const [ownDueDate] = useInvoiceDueDate()
  // A date typed on the card wins over what was learned, which wins over the organization's terms.
  const [typedDueDate, setTypedDueDate] = useState<string | null>(null)
  const [issuance] = useState(() => back?.issuance ?? initialIssuanceValues())
  const [known, setKnown] = useState<{ customers: RequestCustomer[]; catalogItems: CatalogItemOption[] } | null>(() => peekRequestData<{ customers: RequestCustomer[]; catalogItems: CatalogItemOption[] }>(customersKey) ?? null)
  const [picked, setPicked] = useState(initialContactId ?? "")
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
  const dismissRef = useRef(onDismiss)
  useEffect(() => { dismissRef.current = onDismiss })

  useEffect(() => {
    let cancelled = false
    readCustomers()
      .then(value => { if (!cancelled) setKnown(value) })
      .catch(() => { if (!cancelled) setError(t("invoiceValidation.unknown")) })
    return () => { cancelled = true }
  }, [t])

  const draft = useMemo(() => intent.suggested ?? (known && parseRequest(intent.input, { customers: known.customers, catalogItems: known.catalogItems })), [known, intent.input, intent.suggested])
  const match = draft?.customer
  const contactId = picked || back?.contactId || (match?.status === "matched" ? match.candidates[0]!.id : "")
  const customerName = known?.customers.find(customer => customer.id === contactId)?.name
  const terms = useLearnedPaymentTerms(contactId)
  // The learned date only pre-fills the field; the card sends whatever the field holds when Send faktura is clicked.
  const learnedShown = !back?.dueDate && typedDueDate === null ? terms.learned : null
  const dueDate = back?.dueDate || (typedDueDate ?? learnedShown?.dueDate ?? ownDueDate)

  async function changeLearned(action: () => Promise<void>) {
    setError(null)
    try { await action() } catch { setError(t("shell.request.invoice.asLastError")) }
  }

  useEffect(() => {
    if (!known) return
    let cancelled = false
    // Before settings load, let the server use the organization's currency instead of the fallback.
    trpc.invoices.sendReadiness.query({ contactId: contactId || undefined, currency: currencyLoaded ? currency : undefined })
      .then(state => { if (!cancelled) setReadiness(state) })
      .catch(() => { if (!cancelled) setError(t("invoiceValidation.unknown")) })
    return () => { cancelled = true }
  }, [known, contactId, currency, currencyLoaded, t])

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

  const [editedItems, setEditedItems] = useState<InvoiceHandoff["items"] | null>(null)
  const parsed = draft?.items[0]
  const suggested = intent.suggested?.items.map(line => ({ description: line.description, quantity: line.quantity ?? "1", unitPrice: line.unitPrice ?? "" }))
  const base: InvoiceHandoff["items"] = back?.items ?? (repeat ? last?.items ?? [] : suggested ?? (parsed ? [{ description: (parsed.description || draft?.remainder || "").trim(), quantity: parsed.quantity ?? "1", unitPrice: parsed.unitPrice ?? "" }] : []))
  // What was filled in on the card stays as the request is typed on; the rest follows the request.
  const [filled, setFilled] = useState<Record<number, Partial<Pick<InvoiceHandoff["items"][number], "description" | "unitPrice">>>>({})
  const items = editedItems ?? base.map((item, index) => ({ ...item, ...filled[index], ...(quantities[index] !== undefined && { quantity: quantities[index] }) }))
  const lines = items.map(item => normalizeInvoiceQuantity(item, locale))
  const taxRate = back?.taxRate ?? (readiness ? defaultDocumentTaxRate(readiness) : "0")
  const pricesIncludeTax = back?.pricesIncludeTax ?? last?.pricesIncludeTax ?? (readiness && readiness.standardVatRate == null ? readiness.pricesIncludeTax : false)
  // The form's own arithmetic; the card never adds up a figure itself.
  const preview = previewDraft({ items: lines, taxRate, pricesIncludeTax, currency })
  const money = (value: string | number | undefined) => value === undefined || !preview.result || !readiness ? "—" : formatCurrency(Number(value), currency, locale)
  const total = money(preview.result?.gross)

  const gapIn = (item: InvoiceHandoff["items"][number]) =>
    !item.description.trim() || !documentLineV2InputSchema.shape.description.safeParse(item.description).success ? "description" as const
    : !quantityDecimalSchema.safeParse(item.quantity).success ? "quantity" as const
    : !documentLineV2InputSchema.shape.unitPrice.safeParse(item.unitPrice).success ? "unitPrice" as const : null
  const columns = { description: t("docForm.column.description"), quantity: t("docForm.column.qty"), unitPrice: t("docForm.column.unitPrice") }
  // What the request left out is asked for in its place in the line, rather than named below it.
  const asked = base.map(item => ({ description: !item.description.trim(), unitPrice: item.unitPrice === "" }))
  const gap = lines.map((line, index) => ({ index, field: gapIn(line) })).find(entry => entry.field)
  const missing = !contactId ? t("docForm.contact")
    : !lines.length ? t("docForm.lineItems")
    : gap?.field ? columns[gap.field] : !dueDate ? t("invoices.new.field.dueDate") : null
  const askedInPlace = !intent.suggested && !!gap?.field && gap.field !== "quantity" && !!asked[gap.index]?.[gap.field]
  const foreign = !!readiness?.baseCurrency && readiness.baseCurrency !== currency
  const blocker = readiness?.issues[0]
  const blockedBy = missing ? t("shell.request.invoice.gap", { field: missing })
    : foreign ? t("shell.request.invoice.foreignCurrency")
    : blocker ? t(invoiceIssueKey(blocker.code, blocker.field), blocker.params) : null
  const note = error ?? (repeat && last === null && !back ? t("shell.request.repeat.none") : askedInPlace ? null : blockedBy)
  const fill = (index: number, field: "description" | "unitPrice", value: string) =>
    setFilled(current => ({ ...current, [index]: { ...current[index], [field]: value } }))

  // The page shows the invoice this would add, while the card is looked at.
  const gross = preview.result?.gross
  useEffect(() => {
    previewRequest(!sent && customerName && gross !== undefined && Number(gross) > 0 ? { kind: "invoice", customer: customerName, amount: Number(gross), currency, dueDate } : null)
  }, [sent, customerName, gross, currency, dueDate])
  useEffect(() => () => previewRequest(null), [])

  async function send() {
    if (sending.current || blockedBy) return
    sending.current = true
    setPending(true); setError(null)
    try {
      // The recipient version is read again at the click, as the form does, so the server can refuse a changed contact.
      const state = await trpc.invoices.sendReadiness.query({ contactId, currency })
      if (state.policyUnavailable || state.issues.length || !state.recipientVersion) {
        setError(state.policyUnavailable ? t("invoiceValidation.policyUnavailable") : state.issues[0] ? t(invoiceIssueKey(state.issues[0].code, state.issues[0].field), state.issues[0].params) : t("invoiceValidation.unknown"))
        return
      }
      const reviewedRecipient = state.recipientVersion
      const submit = () => submitInvoice(
        { contactId, dueDate, taxRate, pricesIncludeTax, vatEvidence: back?.vatEvidence ?? {}, notes: back?.notes, issuance, currency, baseCurrency: state.baseCurrency, items: lines },
        { sendImmediately: true, holdSend: true, reviewedRecipient, t }
      )
      // The draft exists; the invoice page tells what went wrong, as it does after the form.
      const showFailure = (target: Awaited<ReturnType<typeof submit>>) => {
        void navigate({ to: "/invoices/$invoiceId", params: { invoiceId: target.id }, search: { emailWarning: target.emailWarning, sendError: target.sendError } })
      }
      const target = await submit()
      if (target.sendError || target.emailWarning) {
        showFailure(target)
        onDismiss()
        return
      }
      // The send waits out the undo window; its toast offers Fortryd and tells when it has gone.
      await syncHeldJobs()
      setSent({ id: target.id, amount: total, customer: customerName ?? "" })
    } catch (err) {
      const changed = invoiceFieldIssues(err).find(issue => issue.code === "changed_since_review")
      setError(changed ? t(invoiceIssueKey(changed.code), changed.params) : t("invoiceValidation.unknown"))
    } finally { sending.current = false; setPending(false) }
  }

  function edit() {
    handOff("form", {
      input: intent.input, suggested: intent.suggested, contactId, dueDate, issuance, taxRate, pricesIncludeTax, vatEvidence: back?.vatEvidence ?? {}, notes: back?.notes ?? "",
      items: lines.map(item => ({ ...item, quantity: localizeInvoiceQuantity(item.quantity, locale) })),
    })
    void navigate({ to: "/invoices/new" })
    onDismiss()
  }

  useEffect(() => {
    if (!sent) return
    const leave = setTimeout(() => setLeaving(true), SHRINK_MS + HOLD_MS)
    const close = setTimeout(() => dismissRef.current(), SHRINK_MS + HOLD_MS + LEAVE_MS)
    return () => { clearTimeout(leave); clearTimeout(close) }
  }, [sent])

  if (sent) {
    return (
      <div
        role="status"
        className={cn("request-stagger flex items-center gap-3 overflow-hidden p-6", leaving && "scale-90 opacity-0 transition-[opacity,transform] motion-reduce:scale-100")}
        style={{ "--stagger-delay": `${CHECK_DELAY_MS}ms`, ...(leaving && { transitionDuration: `${LEAVE_MS}ms`, transitionTimingFunction: EASE_ENTER }) } as CSSProperties}
      >
        <span {...stagger(0)} className="bg-tone-success/15 text-tone-success flex size-9 shrink-0 items-center justify-center rounded-full">
          <Check className="size-5" aria-hidden="true" />
        </span>
        <div {...stagger(1)} className="min-w-0">
          <p className="font-semibold">{t("undo.title.invoice")}</p>
          <p className="text-muted-foreground truncate text-sm tabular-nums">{[sent.amount, sent.customer].filter(Boolean).join(" · ")}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4 overflow-hidden p-4">
      {repeat && (
        <div {...stagger(0)}>
          <p className="font-semibold">{t("shell.request.title.repeat")}</p>
          {last?.number && <p className="text-muted-foreground text-sm tabular-nums">{t("shell.request.repeat.copiedFrom", { number: last.number })}</p>}
        </div>
      )}
      <div {...stagger(0)} className="grid gap-1.5 text-sm">
        <span className="text-muted-foreground">{t("docForm.contact")}</span>
        {!known ? <span className="text-muted-foreground">{t("docForm.loadingContacts")}</span>
          : !intent.suggested && (match?.status === "matched" || picked) ? <span className="font-semibold">{customerName}</span>
          : (
            <Select value={intent.suggested ? contactId : picked} onValueChange={setPicked}>
              <SelectTrigger aria-label={t("docForm.contact")} className="w-full"><SelectValue placeholder={t("docForm.selectContact")} /></SelectTrigger>
              <SelectContent>{(intent.suggested ? known.customers : match?.candidates.length ? match.candidates : known.customers).map(customer => <SelectItem key={customer.id} value={customer.id}>{customer.name}</SelectItem>)}</SelectContent>
            </Select>
          )}
      </div>
      {lines.map((line, index) => (
        <div key={index} {...stagger(1)} className="flex items-baseline justify-between gap-3 text-sm">
          <div className="min-w-0 flex-1">
            {intent.suggested ? <div className="grid grid-cols-2 gap-2">
              {(["description", "quantity", "unitPrice"] as const).map(field => <label key={field} className={cn("grid min-w-0 gap-1", field === "description" && "col-span-2")}>
                <span className="text-muted-foreground text-xs">{t(field === "description" ? "docForm.column.description" : field === "quantity" ? "docForm.column.qty" : "docForm.column.unitPrice")}</span>
                <Input type={field === "unitPrice" ? "number" : "text"} inputMode={field === "quantity" ? "decimal" : undefined} min={field === "unitPrice" ? "0" : undefined} step={field === "unitPrice" ? "0.0001" : undefined} value={items[index]![field]} onChange={event => setEditedItems(items.map((item, i) => i === index ? { ...item, [field]: event.target.value } : item))} />
              </label>)}
            </div> : <>
              {asked[index]?.description && !repeat
                ? <Input aria-label={columns.description} placeholder={columns.description} value={items[index]!.description} onChange={event => fill(index, "description", event.target.value)} className="mb-1.5 h-8 max-w-md" />
                : <p className="truncate font-semibold">{line.description}</p>}
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
                ) : localizeInvoiceQuantity(line.quantity, locale)} × {asked[index]?.unitPrice && !repeat
                  ? <Input aria-label={columns.unitPrice} placeholder={columns.unitPrice} type="number" min="0" step="0.0001" value={items[index]!.unitPrice} onChange={event => fill(index, "unitPrice", event.target.value)} className="inline-block h-7 w-28 px-2 text-right tabular-nums" />
                  : line.unitPrice === "" ? "—" : formatCurrency(Number(line.unitPrice), currency, locale)}</p>
            </>}
          </div>
          <span className="tabular-nums">{money(preview.result?.lines[index]?.[pricesIncludeTax ? "gross" : "net"])}</span>
        </div>
      ))}
      <dl {...stagger(2)} className="grid gap-1 border-t pt-3 text-sm tabular-nums">
        <div className="flex justify-between"><dt className="text-muted-foreground">{t("docForm.summary.subtotal")}</dt><dd>{money(preview.result?.net)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted-foreground">{t("docForm.summary.tax")}{readiness ? ` ${taxRate} %` : ""}</dt><dd>{money(preview.result?.tax)}</dd></div>
        <div className="flex justify-between font-semibold"><dt>{t("docForm.summary.total")}</dt><dd>{total}</dd></div>
      </dl>
      <div {...stagger(3)} className="grid gap-1.5 text-sm">
        <label htmlFor="request-due-date" className="text-muted-foreground">{t("invoices.new.field.dueDate")}</label>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <LocalizedDateField id="request-due-date" value={dueDate} onChange={setTypedDueDate} locale={locale} placeholder={t("docForm.selectDate")} clearLabel={t("docForm.clear")} required />
          </div>
          {learnedShown && (
            <span title={t("shell.request.invoice.asLastWhy", { count: learnedShown.count })} className="bg-muted text-muted-foreground flex shrink-0 items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5 text-xs">
              {tCount(t, "shell.request.invoice.asLast", learnedShown.days)}
              <button
                type="button"
                aria-label={t("shell.request.invoice.asLastClear")}
                onClick={() => void changeLearned(terms.clear)}
                className="hover:bg-foreground/10 focus-visible:ring-ring flex size-5 items-center justify-center rounded-full transition-[background-color,box-shadow] focus-visible:ring-2 focus-visible:outline-none"
              ><X className="size-3" aria-hidden="true" /></button>
            </span>
          )}
        </div>
        {terms.cleared && !back?.dueDate && typedDueDate === null && (
          <p role="status" className="text-muted-foreground flex items-center gap-2 text-xs">
            {t("shell.request.invoice.asLastCleared")}
            <button type="button" onClick={() => void changeLearned(terms.restore)} className="text-foreground rounded-sm font-medium underline underline-offset-2 focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none">{t("shell.request.invoice.asLastUndo")}</button>
          </p>
        )}
        <p className="text-muted-foreground">{t("invoices.issuance.supplyDate")} {formatDate(issuance.supplyDate, locale)}</p>
      </div>
      {note && <p role="alert" className="text-sm text-destructive">{note}</p>}
      <div {...stagger(4)} className="flex justify-end gap-2">
        {/* The shadcn default animates every property; name the ones that change. */}
        <Button type="button" variant="outline" onClick={onDismiss} disabled={pending} className="transition-[color,background-color,box-shadow]">{t("shell.request.dismiss")}</Button>
        <Button type="button" variant="outline" onClick={edit} disabled={pending || !readiness} className="transition-[color,background-color,box-shadow]">{t("shell.request.invoice.edit")}</Button>
        <Button data-primary type="button" disabled={pending || !readiness || !!blockedBy} onClick={() => void send()} className="transition-[color,background-color,box-shadow]">{pending ? t("invoices.detail.action.sending") : t("invoiceSend.confirm")}</Button>
      </div>
    </div>
  )
}
