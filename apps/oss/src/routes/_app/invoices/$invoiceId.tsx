import { IssuanceFields, initialIssuanceValues, issuanceInput } from "../../../components/invoices/issuance-fields"
import { previewDraft, percentageToFraction } from "@quits/shared/pricing"
import type { DocumentLineInput } from "@quits/contracts/invoices"
import { draftVatEvidenceSchema, type DraftVatEvidence } from "@quits/contracts/vat"
import { DocumentVatFields, VatGroupPreview } from "../../../components/document-vat-fields"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useState, useEffect } from "react"
import { trpc } from "../../../trpc/client"
import { usePollWhile } from "../../../hooks/use-poll-while"
import { useDocumentResponseGuard } from "../../../hooks/use-document-response-guard"
import { applyCatalogItemToLineItem, type CatalogItemOption } from "../../../lib/catalog"
import {
  readEmailDeliveryAttempt,
  type EmailDeliveryRuntimeStatus,
} from "../../../lib/email-delivery"
import { LocalizedDateField } from "../../../components/localized-date-field"
import { EmailDeliveryPanel } from "../../../components/documents/email-delivery-panel"
import { ReloadRequiredNotice } from "../../../components/documents/reload-required-notice"
import {
  formatCurrency as formatCurrencyIntl,
  formatDate as formatDateIntl,
} from "../../../lib/i18n/format"
import { Button } from "../../../components/ui/button"
import { StatusBadge } from "../../../components/status-badge"
import { Input } from "../../../components/ui/input"
import { Label } from "../../../components/ui/label"
import { Textarea } from "../../../components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../../components/ui/alert-dialog"
import { Printer, CheckCircle, Pencil, Trash2, Plus, ArrowLeft, Download } from "lucide-react"
import { useI18n } from "../../../lib/i18n/react"
import { DocumentTotals } from "../../../components/documents/document-totals"
import { lineColumnKeys, type PriceBasis, type VatRow } from "../../../lib/documents/line-amounts"
import { invoiceDisplayStatus } from "../../../lib/payments/invoice-display-status"
import { InvoiceLifecyclePanels } from "../../../components/invoices/panels"

export const Route = createFileRoute("/_app/invoices/$invoiceId")({
  validateSearch: (search: Record<string, unknown>): { emailWarning?: string; sendError?: string } => ({
    emailWarning: typeof search.emailWarning === "string" ? search.emailWarning : undefined,
    // Set when the invoice was created but sending it failed, e.g. the provider refused the email.
    sendError: typeof search.sendError === "string" ? search.sendError : undefined,
  }),
  component: InvoiceDetailPage,
})

type Contact = {
  id: string
  name: string
  email: string | null
  company: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  country: string | null
}

type InvoiceItem = {
  deliverableId?: string | null
  lineNet?: string | number
  lineTax?: string | number
  lineGross?: string | number
  id: string
  description: string
  quantity: number
  unitPrice: number
  total: number
  /** The unit price and amount on the invoice's price basis; absent in older responses. */
  displayUnitPrice?: number
  displayAmount?: number
  sortOrder: number
  quantityInput?: string | null
  unitPriceInput?: string | null
  unitPriceNet?: number
  unitPriceGross?: number
  taxRate?: number
  vatRateInput?: string | null
  vatTreatment?: NonNullable<DocumentLineInput["vat"]>["treatment"]
  vatCountry?: string | null
  vatReasonCode?: NonNullable<DocumentLineInput["vat"]>["reasonCode"]
}

type Invoice = {
  disputed?: boolean
  disputedRevision?: number
  purpose?: "sale" | "prepayment"
  agreementId?: string | null
  agreementTaxRate?: string | null
  id: string
  /** Null until the invoice is sent. */
  number: string | null
  /** The number a draft would take if sent now; not reserved. */
  nextNumber?: string | null
  status: string
  paymentStatus: string
  paidAt: string | null
  issueDate: string
  dueDate: string
  supplyDate?: string | Date | null
  subtotal: number
  taxAmount: number
  total: number
  amountPaid: number
  amountCredited: number
  balanceDue: number
  currency: string
  notes: string | null
  publicPaymentUrl: string | null
  lastEmailAttemptAt: string | Date | null
  lastEmailAttemptOutcome: "sent" | "skipped" | "failed" | "sending" | "unconfirmed" | null
  lastEmailAttemptCode: string | null
  lastEmailAttemptMessage: string | null
  contact: Contact
  items: InvoiceItem[]
  pricesIncludeTax?: boolean
  priceBasis?: PriceBasis
  vatRows?: VatRow[]
  rounding?: string
  vatEvidence?: unknown
}

type EditItem = {
  id?: string
  deliverableId?: string
  frozenNet?: number
  frozenTax?: number
  frozenGross?: number
  description: string
  quantity: string
  unitPrice: string
  catalogItemId?: string
  vat?: DocumentLineInput["vat"]
}

function formatCurrency(amount: number, currency: string, locale?: string | null) {
  return formatCurrencyIntl(amount, currency, locale)
}

function formatDate(dateStr: string, locale?: string | null, timezone?: string | null) {
  return formatDateIntl(dateStr, locale, timezone)
}

function isValidEmailAddress(email: string | null) {
  if (!email) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

function toDateString(value: string | Date) {
  return value instanceof Date ? value.toISOString() : value
}

async function downloadInvoicePdfFile(invoice: Invoice, _orgSettings: unknown) {
  const { downloadDocumentPdf } = await import("../../../lib/documents-download")
  await downloadDocumentPdf("invoice", invoice.id, invoice.number)
}

function InvoiceDetailPage() {
  const { t, locale } = useI18n()
  const { invoiceId } = Route.useParams()
  const { emailWarning, sendError } = Route.useSearch()
  const navigate = useNavigate()
  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [loading, setLoading] = useState(true)
  const [emailDelivery, setEmailDelivery] = useState<EmailDeliveryRuntimeStatus | null>(null)
  const [error, setError] = useState<string | null>(
    sendError
      ? sendError
      : emailWarning
        ? t("invoices.detail.warning.emailSkipped", { reason: emailWarning })
        : null
  )
  const [acting, setActing] = useState(false)
  const [issuance, setIssuance] = useState(initialIssuanceValues)
  const [editing, setEditing] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [acknowledgeDisputed, setAcknowledgeDisputed] = useState(false)
  useEffect(() => { setAcknowledgeDisputed(false) }, [invoice?.disputedRevision])
  const [sendWithoutEmailOpen, setSendWithoutEmailOpen] = useState(false)
  const [orgSettings, setOrgSettings] = useState<{
    companyName?: string | null
    companyEmail?: string | null
    companyPhone?: string | null
    companyAddress?: string | null
    companyLogo?: string | null
    locale?: string | null
    timezone?: string | null
    baseCurrency?: string
    stripeByokConfigured?: boolean
  }>({})
  const [paymentLinkUrl, setPaymentLinkUrl] = useState<string | null>(null)

  // Edit state
  const [contacts, setContacts] = useState<{ id: string; name: string }[]>([])
  const [catalogItems, setCatalogItems] = useState<CatalogItemOption[]>([])
  const [editContactId, setEditContactId] = useState("")
  const [editDueDate, setEditDueDate] = useState("")
  const [editNotes, setEditNotes] = useState("")
  const [editTaxRate, setEditTaxRate] = useState("0")
  const [editVatEvidence, setEditVatEvidence] = useState<DraftVatEvidence>({})
  const [editItems, setEditItems] = useState<EditItem[]>([])

  // The page stays mounted when navigating to another invoice; drop answers for the previous one.
  const beginRequest = useDocumentResponseGuard(invoiceId)

  useEffect(() => {
    const isCurrent = beginRequest(invoiceId)
    Promise.all([
      trpc.invoices.get.query({ id: invoiceId }),
      trpc.settings.get.query(),
    ])
      .then(([data, settings]) => {
        if (!isCurrent()) return
        setInvoice(data as unknown as Invoice)
        setIssuance({ ...initialIssuanceValues(), ...(data.supplyDate ? { supplyDate: new Date(data.supplyDate).toISOString().slice(0, 10) } : {}) })
        setPaymentLinkUrl((data as unknown as Invoice).publicPaymentUrl ?? null)
        setOrgSettings({
          companyName: settings.companyName,
          companyEmail: settings.companyEmail,
          companyPhone: settings.companyPhone,
          companyAddress: settings.companyAddress,
          companyLogo: settings.companyLogo,
          locale: settings.locale,
          timezone: settings.timezone,
          stripeByokConfigured: settings.stripeByokConfigured,
          baseCurrency: settings.baseCurrency,
        })
        setEmailDelivery(settings.emailDelivery)
      })
      .catch(() => {
        if (isCurrent()) setError(t("invoices.detail.error.notFound"))
      })
      .finally(() => {
        if (isCurrent()) setLoading(false)
      })
  }, [beginRequest, invoiceId, t])

  async function reloadInvoice() {
    const isCurrent = beginRequest(invoiceId)
    const updated = await trpc.invoices.get.query({ id: invoiceId })
    if (!isCurrent()) return
    setInvoice(updated as unknown as Invoice)
    setPaymentLinkUrl((updated as unknown as Invoice).publicPaymentUrl ?? null)
  }

  /** After a failed send: a refused email is recorded on the invoice, so show its new state. */
  async function reloadInvoiceAfterFailure() {
    try {
      await reloadInvoice()
    } catch {
      // Keep the send error on screen; the invoice reloads on the next visit.
    }
  }

  // While the outbox is still delivering the email the invoice is frozen; follow it until it settles.
  const emailSending = invoice?.lastEmailAttemptOutcome === "sending"
  const pollFailure = usePollWhile(emailSending, reloadInvoice)

  function startEditing() {
    if (!invoice) return
    setEditContactId(invoice.contact.id)
    setEditDueDate(new Date(invoice.dueDate).toISOString().split("T")[0])
    setEditNotes(invoice.notes ?? "")
    setEditTaxRate(invoice.agreementTaxRate ?? String(invoice.items.find((item) => Number(item.taxRate) > 0)?.taxRate ?? 0))
    const evidence = draftVatEvidenceSchema.safeParse(invoice.vatEvidence ?? {})
    setEditVatEvidence(evidence.success ? evidence.data : {})
    setEditItems(
      invoice.items.map((item) => ({
        id: item.id, deliverableId: item.deliverableId ?? undefined,
        ...(item.deliverableId ? { frozenNet: Number(item.lineNet), frozenTax: Number(item.lineTax), frozenGross: Number(item.lineGross) } : {}),
        description: item.description,
        quantity: item.quantityInput ?? String(item.quantity),
        unitPrice: item.unitPriceInput ?? String(invoice.pricesIncludeTax ? item.unitPriceGross ?? item.unitPrice : item.unitPriceNet ?? item.unitPrice),
        vat: { treatment: item.vatTreatment ?? (Number(item.taxRate) > 0 ? "standard" : "unclassified_zero"), rate: item.vatRateInput ?? percentageToFraction(item.taxRate ?? 0), country: item.vatCountry, reasonCode: item.vatReasonCode },
        catalogItemId: undefined,
      }))
    )
    Promise.all([trpc.contacts.list.query(), trpc.catalog.list.query()]).then(
      ([contactsData, catalogData]) => {
        setContacts(contactsData as { id: string; name: string }[])
        setCatalogItems(catalogData as CatalogItemOption[])
      }
    )
    setEditing(true)
  }

  function updateEditItem(index: number, field: keyof EditItem, value: string) {
    setEditItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: value } : item))
    )
  }

  function addEditItem() {
    setEditItems((prev) => [...prev, { description: "", quantity: "1", unitPrice: "0" }])
  }

  function removeEditItem(index: number) {
    if (editItems.length <= 1) return
    setEditItems((prev) => prev.filter((_, i) => i !== index))
  }

  function applyCatalogItemToEditItem(index: number, catalogItemId: string) {
    setEditItems((prev) =>
      prev.map((item, i) => {
        if (i !== index) return item
        return applyCatalogItemToLineItem(item, catalogItemId, catalogItems)
      })
    )
  }

  async function handleSaveEdit() {
    if (!invoice) return
    setError(null)
    setActing(true)
    const isCurrent = beginRequest(invoice.id)
    try {
      const updated = await trpc.invoices.updateV2.mutate({
        id: invoice.id,
        contactId: editContactId,
        dueDate: editDueDate,
        notes: editNotes,
        ...(invoice.agreementId ? {} : { taxRate: editTaxRate }),
        vatEvidence: editVatEvidence,
        items: editItems.map((item) => ({
          id: item.id, deliverableId: item.deliverableId,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          vat: item.vat,
        })),
      })
      if (!isCurrent()) return
      setInvoice(updated as unknown as Invoice)
      setEditing(false)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("invoices.detail.error.updateFailed")
      )
    } finally {
      setActing(false)
    }
  }

  async function handleSend(allowSendWithoutEmail = false) {
    if (!invoice) return
    setError(null)
    setActing(true)
    try {
      const result = await trpc.invoices.send.mutate({
        id: invoice.id,
        allowSendWithoutEmail,
        acknowledgeDisputed,
        ...issuanceInput(issuance, invoice.currency, orgSettings.baseCurrency),
      })
      await reloadInvoice()
      setSendWithoutEmailOpen(false)
      if (result.emailSkipReason) {
        setError(
          t("invoices.detail.warning.emailSkipped", {
            reason: result.emailSkipReason,
          })
        )
      }
    } catch (err) {
      setError(
        invoice.disputed && !acknowledgeDisputed
          ? t("agreements.disputedSendRefused")
          : err instanceof Error
          ? err.message
          : t("invoices.detail.error.sendFailed")
      )
      await reloadInvoiceAfterFailure()
    } finally {
      setActing(false)
    }
  }

  async function handleResendEmail() {
    if (!invoice) return
    setError(null)
    setActing(true)
    try {
      await trpc.invoices.resendEmail.mutate({ id: invoice.id })
      await reloadInvoice()
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("invoices.detail.error.sendFailed")
      )
      await reloadInvoiceAfterFailure()
    } finally {
      setActing(false)
    }
  }

  async function handleMarkPaid() {
    if (!invoice) return
    setActing(true)
    try {
      await trpc.invoices.markPaid.mutate({ invoiceId: invoice.id, requestId: crypto.randomUUID() })
      await reloadInvoice()
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("invoices.detail.error.markPaidFailed")
      )
    } finally {
      setActing(false)
    }
  }

  async function handleCreatePaymentLink() {
    if (!invoice) return
    setActing(true)
    try {
      const result = await trpc.invoices.createPaymentLink.mutate({ id: invoice.id })
      setPaymentLinkUrl(result.url)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("invoices.detail.error.paymentLinkFailed")
      )
    } finally {
      setActing(false)
    }
  }

  async function handleDelete() {
    if (!invoice) return
    setActing(true)
    try {
      await trpc.invoices.delete.mutate({ id: invoice.id })
      navigate({ to: "/invoices" })
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("invoices.detail.error.deleteFailed")
      )
      setActing(false)
    }
  }

  function handlePrint() {
    window.print()
  }

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">{t("invoices.loading")}</p>
      </div>
    )
  }

  if (!invoice) {
    return (
      <div className="p-6">
        <p className="text-destructive">
          {error ?? t("invoices.detail.error.notFound")}
        </p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => navigate({ to: "/invoices" })}
        >
          {t("invoices.detail.action.back")}
        </Button>
      </div>
    )
  }

  // Edit mode
  if (editing) {
    const preview = previewDraft({ items: editItems.filter(item => !item.deliverableId), taxRate: editTaxRate || "0", pricesIncludeTax: invoice.pricesIncludeTax ?? false, currency: invoice.currency })
    const editSubtotal = Number(preview.result?.net ?? "0") + editItems.reduce((sum, item) => sum + (item.frozenNet ?? 0), 0)
    const editTaxAmount = Number(preview.result?.tax ?? "0") + editItems.reduce((sum, item) => sum + (item.frozenTax ?? 0), 0)
    const editTotal = Number(preview.result?.gross ?? "0") + editItems.reduce((sum, item) => sum + (item.frozenGross ?? 0), 0)

    return (
      <div className="p-6 max-w-3xl">
        <Card>
          <CardHeader>
            <CardTitle>
              {[t("invoices.detail.editTitle"), invoice.number].filter(Boolean).join(" ")}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-6">
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>{t("docForm.contact")} *</Label>
                <Select disabled={!!invoice.agreementId} value={editContactId} onValueChange={setEditContactId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t("docForm.selectContact")} />
                  </SelectTrigger>
                  <SelectContent>
                    {contacts.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="editDueDate">{t("invoices.new.field.dueDate")} *</Label>
                <LocalizedDateField
                  id="editDueDate"
                  value={editDueDate}
                  onChange={setEditDueDate}
                  locale={locale}
                  placeholder={t("docForm.selectDate")}
                  clearLabel={t("docForm.clear")}
                />
              </div>
            </div>

            {/* Line Items */}
            <div className="grid gap-3">
              <Label>{t("docForm.lineItems")}</Label>
              <div className="rounded-md border">
                <div className="grid grid-cols-[180px_1fr_80px_100px_100px_40px] gap-2 p-3 border-b bg-muted/50 text-sm font-medium">
                  <span>{t("docForm.column.item")}</span>
                  <span>{t("docForm.column.description")}</span>
                  <span>{t("docForm.column.qty")}</span>
                  <span>{t("docForm.column.unitPrice")}</span>
                  <span>{t("docForm.column.total")}</span>
                  <span />
                </div>
                {editItems.map((item, index) => (
                  <div
                    key={index}
                    className="grid grid-cols-[180px_1fr_80px_100px_100px_40px] gap-2 p-3 border-b last:border-0 items-center"
                  >
                    <Select
                      disabled={!!item.deliverableId}
                      value={item.catalogItemId}
                      onValueChange={(value) => applyCatalogItemToEditItem(index, value)}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue
                          placeholder={
                            catalogItems.length > 0
                              ? t("docForm.selectItem")
                              : t("docForm.noSavedItems")
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {catalogItems.map((catalogItem) => (
                          <SelectItem key={catalogItem.id} value={catalogItem.id}>
                            {catalogItem.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      placeholder={t("docForm.column.description")}
                      disabled={!!item.deliverableId}
                      value={item.description}
                      onChange={(e) => updateEditItem(index, "description", e.target.value)}
                    />
                    <Input
                      type="number"
                      min="0.000001"
                      step="0.000001"
                      disabled={!!item.deliverableId}
                      value={item.quantity || ""}
                      onChange={(e) =>
                        updateEditItem(index, "quantity", e.target.value)
                      }
                    />
                    <Input
                      type="number"
                      min="0"
                      step="0.0001"
                      disabled={!!item.deliverableId}
                      value={item.unitPrice || ""}
                      onChange={(e) =>
                        updateEditItem(index, "unitPrice", e.target.value)
                      }
                    />
                    <span className="num text-sm text-right pr-2">
                      {preview.result ? formatCurrency(item.deliverableId ? (invoice.pricesIncludeTax ? item.frozenGross ?? 0 : item.frozenNet ?? 0) : Number(preview.result.lines[editItems.slice(0, index + 1).filter(line => !line.deliverableId).length - 1]?.[invoice.pricesIncludeTax ? "gross" : "net"] ?? "0"), invoice.currency, locale) : "—"}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeEditItem(index)}
                      disabled={editItems.length <= 1}
                    >
                      <Trash2 className="size-4 text-muted-foreground" />
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addEditItem}
                className="w-fit"
              >
                <Plus className="size-4" />
                {t("docForm.action.addItem")}
              </Button>
            </div>

            {/* Summary */}
            <DocumentVatFields items={editItems} onItemsChange={setEditItems} taxRate={editTaxRate} evidence={editVatEvidence} onEvidenceChange={setEditVatEvidence} classificationReadOnly={!!invoice.agreementId} />
            {!invoice.agreementId && <VatGroupPreview {...preview} />}
            <div className="flex justify-end">
              <div className="w-64 grid gap-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("docForm.summary.subtotal")}</span>
                  <span className="num">{preview.result ? formatCurrency(editSubtotal, invoice.currency, locale) : "—"}</span>
                </div>
                <div className="flex justify-between items-center gap-2">
                  <span className="text-muted-foreground">{t("docForm.summary.tax")}</span>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      disabled={!!invoice.agreementId}
                      step="0.01"
                      value={editTaxRate || ""}
                      onChange={(e) => { setEditTaxRate(e.target.value); setEditItems((lines) => lines.map((line) => ({ ...line, vat: undefined }))) }}
                      className="w-16 h-7 text-xs"
                    />
                    <span className="text-muted-foreground text-xs">%</span>
                    <span className="ml-auto num">{preview.result ? formatCurrency(editTaxAmount, invoice.currency, locale) : "—"}</span>
                  </div>
                </div>
                <div className="flex justify-between font-semibold border-t pt-2">
                  <span>{t("docForm.summary.total")}</span>
                  <span className="num">{preview.result ? formatCurrency(editTotal, invoice.currency, locale) : "—"}</span>
                </div>
              </div>
            </div>

            {/* Notes */}
            <div className="grid gap-2">
              <Label htmlFor="editNotes">{t("docForm.notes")}</Label>
              <Textarea
                id="editNotes"
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                placeholder={t("invoices.new.notes.placeholder")}
                rows={3}
              />
            </div>
          </CardContent>
          <CardFooter className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setEditing(false)
                setError(null)
              }}
            >
              {t("docForm.action.cancel")}
            </Button>
            <Button type="button" disabled={acting} onClick={handleSaveEdit}>
              {acting
                ? t("docForm.action.saving")
                : t("docForm.action.saveChanges")}
            </Button>
          </CardFooter>
        </Card>
      </div>
    )
  }

  // View mode
  const contact = invoice.contact
  const emailAttempt = readEmailDeliveryAttempt({
    lastEmailAttemptAt: invoice.lastEmailAttemptAt
      ? new Date(toDateString(invoice.lastEmailAttemptAt))
      : null,
    lastEmailAttemptOutcome: invoice.lastEmailAttemptOutcome,
    lastEmailAttemptCode: invoice.lastEmailAttemptCode,
    lastEmailAttemptMessage: invoice.lastEmailAttemptMessage,
  })
  const recipientEmailValid = isValidEmailAddress(contact.email)
  const canResendEmail = invoice.status === "sent" || invoice.status === "overdue"
  const canShowDegradedSend =
    invoice.purpose !== "prepayment" && invoice.status === "draft" && recipientEmailValid && emailDelivery && !emailDelivery.available
  const deliveryStatus = emailAttempt
    ? {
        outcome: emailAttempt.lastEmailAttemptOutcome,
        label: t(`invoices.detail.email.status.${emailAttempt.lastEmailAttemptOutcome}`),
        detail: t("invoices.detail.email.lastAttempt", {
          status: t(`invoices.detail.email.status.${emailAttempt.lastEmailAttemptOutcome}`),
          at: formatDate(
            toDateString(emailAttempt.lastEmailAttemptAt),
            locale,
            orgSettings.timezone
          ),
        }),
        message:
          emailAttempt.lastEmailAttemptOutcome === "unconfirmed"
            ? t("invoices.detail.email.reason.unconfirmed")
            : emailAttempt.lastEmailAttemptCode === "provider_missing"
            ? t("invoices.detail.email.reason.provider_missing")
            : emailAttempt.lastEmailAttemptCode === "send_failed"
              ? t("invoices.detail.email.reason.send_failed")
              : emailAttempt.lastEmailAttemptOutcome === "sending"
                ? t("invoices.detail.email.reason.sending")
              : emailAttempt.lastEmailAttemptCode === "sent"
                ? t("invoices.detail.email.reason.sent")
                : emailAttempt.lastEmailAttemptMessage,
      }
    : null
  const recipientFallback =
    !recipientEmailValid ? {
      title: t("invoices.detail.email.fallback.invalidRecipient.title"),
      description:
        paymentLinkUrl && invoice.paymentStatus !== "paid"
          ? t("invoices.detail.email.fallback.invalidRecipient.description")
          : t("invoices.detail.email.fallback.invalidRecipient.descriptionNoLink"),
      copyLabel:
        paymentLinkUrl && invoice.paymentStatus !== "paid"
          ? t("invoices.detail.paymentLink.copy")
          : undefined,
      onCopy:
        paymentLinkUrl && invoice.paymentStatus !== "paid"
          ? () => {
              navigator.clipboard.writeText(paymentLinkUrl)
            }
          : undefined,
      fixAction: (
        <Button asChild variant="outline">
          <Link to="/contacts/$contactId" params={{ contactId: contact.id }}>
            {t("invoices.detail.email.fallback.invalidRecipient.fix")}
          </Link>
        </Button>
      ),
    } : !emailDelivery?.available && canResendEmail && paymentLinkUrl && invoice.paymentStatus !== "paid" ? {
      title: t("invoices.detail.email.fallback.providerMissing.title"),
      description: t("invoices.detail.email.fallback.providerMissing.description"),
      copyLabel: t("invoices.detail.paymentLink.copy"),
      onCopy: () => {
        navigator.clipboard.writeText(paymentLinkUrl)
      },
    } : null

  return (
    <div className="p-6 max-w-3xl">
      {invoice.purpose === "prepayment" && invoice.status === "draft" && <section className="rounded-md border p-4 grid gap-3">
        <p>{t("agreements.prepaymentNotice")}</p>
        <AlertDialog><AlertDialogTrigger asChild><Button disabled={acting}>{t("agreements.convertSchedule")}</Button></AlertDialogTrigger>
          <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("agreements.convertSchedule")}</AlertDialogTitle><AlertDialogDescription>{t("agreements.convertScheduleConfirm")}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>{t("agreements.cancel")}</AlertDialogCancel><AlertDialogAction onClick={async () => {
            setActing(true)
            try { await trpc.invoices.scheduleAsSale.mutate({ id: invoice.id, confirmed: true }); await reloadInvoice() }
            catch (failure) { setError(failure instanceof Error ? failure.message : t("agreements.error")) }
            finally { setActing(false) }
          }}>{t("agreements.convertSchedule")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
        </AlertDialog>
      </section>}

      {/* Print styles */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .print-area, .print-area * { visibility: visible; }
          .print-area { position: absolute; left: 0; top: 0; width: 100%; padding: 2rem; }
          .no-print { display: none !important; }
        }
      `}</style>

      {/* Back button and actions */}
      <div className="flex items-center justify-between mb-6 no-print">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/invoices" })}>
          <ArrowLeft className="size-4" />
          {t("invoices.detail.action.back")}
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handlePrint}>
            <Printer className="size-4" />
            {t("invoices.detail.action.print")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={downloading}
            onClick={async () => {
              if (!invoice) return
              setDownloading(true)
              try {
                await downloadInvoicePdfFile(invoice, orgSettings)
              } catch {
                setError(t("invoices.detail.error.pdfFailed"))
              } finally {
                setDownloading(false)
              }
            }}
          >
            <Download className="size-4" />
            {downloading ? t("invoices.new.ai.action.generating") : "PDF"}
          </Button>
          {/* A draft whose email is still being delivered can no longer be edited or deleted. */}
          {invoice.status === "draft" && !emailSending && <IssuanceFields value={issuance} onChange={setIssuance} currency={invoice.currency} baseCurrency={orgSettings.baseCurrency} />}
          {invoice.status === "draft" && !emailSending && (
            <>
              <Button variant="outline" size="sm" disabled={acting} onClick={startEditing}>
                <Pencil className="size-4" />
                {t("invoices.detail.action.edit")}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm" disabled={acting}>
                    <Trash2 className="size-4" />
                    {t("invoices.detail.action.delete")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("invoices.delete.title")}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {invoice.number
                        ? t("invoices.delete.description", { number: invoice.number })
                        : t("invoices.delete.descriptionDraft")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("docForm.action.cancel")}</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={handleDelete}>
                      {t("invoices.detail.action.delete")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
          {(invoice.status === "sent" || invoice.status === "overdue") && (
            <div className="flex items-center gap-2">
              {orgSettings.stripeByokConfigured && invoice.paymentStatus !== "paid" && (
                <Button variant="outline" size="sm" disabled={acting} onClick={handleCreatePaymentLink}>
                  {acting
                    ? t("invoices.detail.action.generatingPaymentLink")
                    : t("invoices.detail.action.createPaymentLink")}
                </Button>
              )}
              <Button size="sm" disabled={acting} onClick={handleMarkPaid}>
                <CheckCircle className="size-4" />
                {acting
                  ? t("invoices.detail.action.updating")
                  : t("invoices.detail.action.markPaid")}
              </Button>
            </div>
          )}
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive mb-4 no-print" role="alert">
          {error}
        </p>
      )}

      <div className="mb-4 no-print empty:hidden">
        <ReloadRequiredNotice failure={pollFailure} />
      </div>

      {/* Invoice content (printable) */}
      <div className="print-area">
        <Card>
          <CardContent className="p-6 grid gap-6">
            {invoice.disputed && invoice.status === "draft" && <section className="grid gap-2 no-print">
              <p role="status">{t("agreements.disputedDraft")}</p>
              <label className="flex items-start gap-2"><input type="checkbox" checked={acknowledgeDisputed} disabled={acting || emailSending} onChange={event => setAcknowledgeDisputed(event.target.checked)} />{t("agreements.acknowledgeDisputed")}</label>
            </section>}
            <EmailDeliveryPanel
              className="no-print"
              title={t("invoices.detail.email.title")}
              description={t("invoices.detail.email.description")}
              status={deliveryStatus}
              action={
                invoice.purpose !== "prepayment" && invoice.status === "draft" && recipientEmailValid && emailDelivery?.available
                  ? {
                      label: t("invoices.detail.action.send"),
                      pendingLabel: t("invoices.detail.action.sending"),
                      pending: acting,
                      // A queued email settles on its own; sending again is refused meanwhile.
                      disabled: acting || emailSending,
                      onClick: () => {
                        void handleSend()
                      },
                    }
                  : canResendEmail && recipientEmailValid && emailDelivery?.available
                    ? {
                        label: t("invoices.detail.action.resendEmail"),
                        pendingLabel: t("invoices.detail.action.sending"),
                        pending: acting,
                        disabled: acting || emailSending,
                        onClick: () => {
                          void handleResendEmail()
                        },
                      }
                    : null
              }
              degradedAction={
                canShowDegradedSend && !emailSending
                  ? {
                      open: sendWithoutEmailOpen,
                      triggerLabel: t("invoices.detail.email.degraded.trigger"),
                      title: t("invoices.detail.email.degraded.title"),
                      description: t("invoices.detail.email.degraded.description"),
                      confirmLabel: t("invoices.detail.email.degraded.confirm"),
                      cancelLabel: t("invoices.detail.email.degraded.cancel"),
                      pending: acting,
                      onConfirm: () => {
                        void handleSend(true)
                      },
                      onOpenChange: setSendWithoutEmailOpen,
                    }
                  : null
              }
              fallback={recipientFallback}
              publicLink={
                paymentLinkUrl && invoice.paymentStatus !== "paid"
                  ? {
                      title: t("invoices.detail.paymentLink.title"),
                      description: t("invoices.detail.paymentLink.description"),
                      url: paymentLinkUrl,
                      copyLabel: t("invoices.detail.paymentLink.copy"),
                      onCopy: () => {
                        navigator.clipboard.writeText(paymentLinkUrl)
                      },
                    }
                  : null
              }
            />

            {/* Header */}
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-2xl font-bold">
                  {invoice.number ? `${t("pdf.invoice")} ${invoice.number}` : t("invoices.number.draftHeading")}
                </h1>
                {invoice.number === null && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {invoice.nextNumber
                      ? t("invoices.number.willBe", { number: invoice.nextNumber })
                      : t("invoices.number.assignedOnSend")}
                  </p>
                )}
                <div className="mt-1">
                  <StatusBadge domain="invoice" status={invoiceDisplayStatus(invoice)} />
                </div>
              </div>
              <div className="text-right text-sm text-muted-foreground">
                {orgSettings.companyLogo && (
                  <img
                    src={orgSettings.companyLogo}
                    alt={t("invoices.detail.companyLogoAlt")}
                    className="ml-auto mb-2 h-12 w-auto max-w-40 object-contain"
                  />
                )}
                <p>
                  <span className="font-medium text-foreground">
                    {t("pdf.issueDate")}:
                  </span>{" "}
                  {formatDate(invoice.issueDate, locale, orgSettings.timezone)}
                </p>
                <p>
                  <span className="font-medium text-foreground">
                    {t("pdf.dueDate")}:
                  </span>{" "}
                  {formatDate(invoice.dueDate, locale, "UTC")}
                </p>
                {invoice.supplyDate && (
                  <p>
                    <span className="font-medium text-foreground">
                      {t("pdf.supplyDate")}:
                    </span>{" "}
                    {/* A calendar date, not an instant: the organization's time zone must not move it a day. */}
                    {formatDate(new Date(invoice.supplyDate).toISOString(), locale, "UTC")}
                  </p>
                )}
              </div>
            </div>

            {/* Bill To */}
            <div>
              <h3 className="text-sm font-medium text-muted-foreground mb-1">
                {t("pdf.billTo")}
              </h3>
              <p className="font-semibold">{contact.name}</p>
              {contact.company && <p className="text-sm">{contact.company}</p>}
              {contact.email && (
                <p className="text-sm text-muted-foreground">{contact.email}</p>
              )}
              {contact.address && <p className="text-sm">{contact.address}</p>}
              {(contact.city || contact.state || contact.zip) && (
                <p className="text-sm">
                  {[contact.city, contact.state, contact.zip].filter(Boolean).join(", ")}
                </p>
              )}
              {contact.country && <p className="text-sm">{contact.country}</p>}
            </div>

            {/* Items Table */}
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("pdf.description")}</TableHead>
                    <TableHead className="text-right w-[80px]">{t("pdf.qty")}</TableHead>
                    <TableHead className="text-right w-[140px]">{t(lineColumnKeys(invoice.priceBasis).unitPrice)}</TableHead>
                    <TableHead className="text-right w-[140px]">{t(lineColumnKeys(invoice.priceBasis).amount)}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoice.items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>{item.description}</TableCell>
                      <TableCell className="text-right num">{item.quantity}</TableCell>
                      <TableCell className="text-right num">
                        {formatCurrency(item.displayUnitPrice ?? item.unitPrice, invoice.currency, locale)}
                      </TableCell>
                      <TableCell className="text-right num">
                        {formatCurrency(item.displayAmount ?? item.total, invoice.currency, locale)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Totals */}
            <div className="flex justify-end">
              <div className="w-full sm:w-80 grid gap-2 text-sm">
                <DocumentTotals priceBasis={invoice.priceBasis} subtotal={invoice.subtotal} taxAmount={invoice.taxAmount} total={invoice.total} vatRows={invoice.vatRows} rounding={invoice.rounding} currency={invoice.currency} />
                {invoice.status !== "draft" && (invoice.amountPaid > 0 || invoice.amountCredited > 0) && (
                  <>
                    {invoice.amountPaid > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t("payments.summary.paid")}</span>
                        <span className="num">-{formatCurrency(invoice.amountPaid, invoice.currency, locale)}</span>
                      </div>
                    )}
                    {invoice.amountCredited > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t("payments.summary.credited")}</span>
                        <span className="num">-{formatCurrency(invoice.amountCredited, invoice.currency, locale)}</span>
                      </div>
                    )}
                    <div className="flex justify-between font-semibold border-t pt-2">
                      <span>{t("payments.summary.balanceDue")}</span>
                      <span className="num">{formatCurrency(invoice.balanceDue, invoice.currency, locale)}</span>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Notes */}
            {invoice.notes && (
              <div>
                <h3 className="text-sm font-medium text-muted-foreground mb-1">
                  {t("pdf.notes")}
                </h3>
                <p className="text-sm whitespace-pre-wrap">{invoice.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <InvoiceLifecyclePanels
        invoice={invoice}
        locale={orgSettings.locale}
        onChanged={reloadInvoice}
      />
    </div>
  )
}
