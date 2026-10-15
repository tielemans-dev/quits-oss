import { useNavigate } from "@tanstack/react-router"
import { documentLineV2InputSchema } from "@quits/contracts/invoices"
import { previewDraft } from "@quits/shared/pricing"
import { useEffect, useMemo, useRef, useState } from "react"

import { useInvoiceDueDate } from "../../hooks/use-invoice-due-date"
import { useOrgCurrency } from "../../hooks/use-org-currency"
import type { CatalogItemOption } from "../../lib/catalog"
import { formatCurrency, formatDate } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { defaultDocumentTaxRate } from "../../lib/invoice-defaults"
import { invoiceFieldIssues, invoiceIssueKey } from "../../lib/invoice-field-issues"
import { localizeInvoiceQuantity } from "../../lib/invoice-quantity"
import { parseRequest, type RequestCustomer } from "../../lib/request-parser"
import { submitInvoice } from "../../lib/submit-invoice"
import { trpc } from "../../trpc/client"
import { initialIssuanceValues } from "../invoices/issuance-fields"
import { Button } from "../ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { stagger } from "./request-card-slot"
import type { RequestCardProps } from "./request-intent"

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
  const [dueDate] = useInvoiceDueDate()
  const [issuance] = useState(initialIssuanceValues)
  const [known, setKnown] = useState<{ customers: RequestCustomer[]; catalogItems: CatalogItemOption[] } | null>(null)
  const [picked, setPicked] = useState("")
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const sending = useRef(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([trpc.contacts.list.query(), trpc.catalog.list.query().catch(() => [])])
      .then(([customers, catalogItems]) => { if (!cancelled) setKnown({ customers: customers as RequestCustomer[], catalogItems: catalogItems as CatalogItemOption[] }) })
      .catch(() => { if (!cancelled) setError(t("invoiceValidation.unknown")) })
    return () => { cancelled = true }
  }, [t])

  const draft = useMemo(() => known && parseRequest(intent.input, { customers: known.customers, catalogItems: known.catalogItems }), [known, intent.input])
  const match = draft?.customer
  const contactId = picked || (match?.status === "matched" ? match.candidates[0]!.id : "")
  const customerName = known?.customers.find(customer => customer.id === contactId)?.name

  useEffect(() => {
    if (!known) return
    let cancelled = false
    trpc.invoices.sendReadiness.query({ contactId: contactId || undefined, currency })
      .then(state => { if (!cancelled) setReadiness(state) })
      .catch(() => { if (!cancelled) setError(t("invoiceValidation.unknown")) })
    return () => { cancelled = true }
  }, [known, contactId, currency, t])

  const parsed = draft?.items[0]
  const line = parsed && { description: (parsed.description || draft?.remainder || "").trim(), quantity: parsed.quantity ?? "1", unitPrice: parsed.unitPrice ?? "" }
  const taxRate = readiness ? defaultDocumentTaxRate(readiness) : "0"
  const pricesIncludeTax = readiness && readiness.standardVatRate == null ? readiness.pricesIncludeTax : false
  // The form's own arithmetic; the card never adds up a figure itself.
  const preview = previewDraft({ items: line ? [line] : [], taxRate, pricesIncludeTax, currency })
  const money = (value: string | number | undefined) => value === undefined || !preview.result || !readiness ? "—" : formatCurrency(Number(value), currency, locale)
  const total = money(preview.result?.gross)

  const missing = !contactId ? t("docForm.contact")
    : !line ? t("docForm.lineItems")
    : !line.description || !documentLineV2InputSchema.shape.description.safeParse(line.description).success ? t("docForm.column.description")
    : !documentLineV2InputSchema.shape.unitPrice.safeParse(line.unitPrice).success ? t("docForm.column.unitPrice")
    : !dueDate ? t("invoices.new.field.dueDate") : null
  const foreign = !!readiness?.baseCurrency && readiness.baseCurrency !== currency
  const blocker = readiness?.issues[0]
  const blockedBy = missing ? t("shell.request.invoice.gap", { field: missing })
    : foreign ? t("shell.request.invoice.foreignCurrency")
    : blocker ? t(invoiceIssueKey(blocker.code), blocker.params) : null
  const note = error ?? blockedBy

  async function send() {
    if (sending.current || !line || blockedBy) return
    sending.current = true
    setPending(true); setError(null)
    try {
      // The recipient version is read again at the click, as the form does, so the server can refuse a changed contact.
      const state = await trpc.invoices.sendReadiness.query({ contactId, currency })
      if (state.policyUnavailable || state.issues.length || !state.recipientVersion) {
        setError(state.policyUnavailable ? t("invoiceValidation.policyUnavailable") : state.issues[0] ? t(invoiceIssueKey(state.issues[0].code), state.issues[0].params) : t("invoiceValidation.unknown"))
        return
      }
      const target = await submitInvoice(
        { contactId, dueDate, taxRate, pricesIncludeTax, vatEvidence: {}, issuance, currency, baseCurrency: state.baseCurrency, items: [line] },
        { sendImmediately: true, reviewedRecipient: state.recipientVersion, t }
      )
      // As after the form, the invoice page shows the draft or the sent invoice, with what went wrong if anything did.
      void navigate({ to: "/invoices/$invoiceId", params: { invoiceId: target.id }, search: { emailWarning: target.emailWarning, sendError: target.sendError } })
      onDismiss()
    } catch (err) {
      const changed = invoiceFieldIssues(err).find(issue => issue.code === "changed_since_review")
      setError(changed ? t(invoiceIssueKey(changed.code), changed.params) : t("invoiceValidation.unknown"))
    } finally { sending.current = false; setPending(false) }
  }

  return (
    <div className="space-y-4 p-4">
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
      {line && (
        <div {...stagger(1)} className="flex items-baseline justify-between gap-3 text-sm">
          <div className="min-w-0">
            <p className="truncate font-semibold">{line.description}</p>
            <p className="text-muted-foreground tabular-nums">{localizeInvoiceQuantity(line.quantity, locale)} × {line.unitPrice === "" ? "—" : formatCurrency(Number(line.unitPrice), currency, locale)}</p>
          </div>
          <span className="tabular-nums">{money(preview.result?.lines[0]?.[pricesIncludeTax ? "gross" : "net"])}</span>
        </div>
      )}
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
        <Button type="button" disabled={pending || !readiness || !!blockedBy} onClick={() => void send()} className="transition-[color,background-color,box-shadow]">{pending ? t("invoices.detail.action.sending") : t("invoiceSend.confirm")}</Button>
      </div>
    </div>
  )
}
