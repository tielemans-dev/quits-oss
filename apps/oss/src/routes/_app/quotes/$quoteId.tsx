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
import { Badge } from "../../../components/ui/badge"
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
import { Pencil, Trash2, Plus, ArrowLeft, ArrowRight, XCircle } from "lucide-react"
import { useI18n } from "../../../lib/i18n/react"

export const Route = createFileRoute("/_app/quotes/$quoteId")({
  validateSearch: (search: Record<string, unknown>): { emailWarning?: string; sendError?: string } => ({
    emailWarning: typeof search.emailWarning === "string" ? search.emailWarning : undefined,
    // Set when the quote was created but sending it failed, e.g. the provider refused the email.
    sendError: typeof search.sendError === "string" ? search.sendError : undefined,
  }),
  component: QuoteDetailPage,
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

type QuoteItem = {
  id: string
  description: string
  quantity: number
  unitPrice: number
  total: number
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

type Quote = {
  id: string
  number: string
  status: string
  issueDate: string
  expiryDate: string
  subtotal: number
  taxAmount: number
  total: number
  currency: string
  notes: string | null
  publicViewUrl: string | null
  publicDecisionAt: string | null
  publicRejectionReason: string | null
  lastEmailAttemptAt: string | Date | null
  lastEmailAttemptOutcome: "sent" | "skipped" | "failed" | "sending" | "unconfirmed" | null
  lastEmailAttemptCode: string | null
  lastEmailAttemptMessage: string | null
  contact: Contact
  items: QuoteItem[]
  agreement: { id: string; title: string } | null
  invoices: { id: string; number: string }[]
  pricesIncludeTax?: boolean
  vatEvidence?: unknown
}

type EditItem = {
  description: string
  quantity: string
  unitPrice: string
  catalogItemId?: string
  vat?: DocumentLineInput["vat"]
}

const statusConfig: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-muted text-muted-foreground" },
  sent: { label: "Sent", className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" },
  accepted: { label: "Accepted", className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" },
  rejected: { label: "Rejected", className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" },
  expired: { label: "Expired", className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200" },
}

function formatCurrency(amount: number, currency: string, locale?: string | null) {
  return formatCurrencyIntl(amount, currency, locale)
}

function formatDate(dateStr: string, locale?: string | null) {
  return formatDateIntl(dateStr, locale)
}

function isValidEmailAddress(email: string | null) {
  if (!email) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

function toDateString(value: string | Date) {
  return value instanceof Date ? value.toISOString() : value
}

function getQuoteStatusLabel(status: string, t: ReturnType<typeof useI18n>["t"]) {
  if (status === "sent") return t("quotes.status.sent")
  if (status === "accepted") return t("quotes.status.accepted")
  if (status === "rejected") return t("quotes.status.rejected")
  if (status === "expired") return t("quotes.status.expired")
  return t("quotes.status.draft")
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  const config = statusConfig[status] ?? statusConfig.draft
  return (
    <Badge variant="outline" className={config.className}>
      {label}
    </Badge>
  )
}

function QuoteDetailPage() {
  const { t, locale } = useI18n()
  const { quoteId } = Route.useParams()
  const { emailWarning, sendError } = Route.useSearch()
  const navigate = useNavigate()
  const [quote, setQuote] = useState<Quote | null>(null)
  const [loading, setLoading] = useState(true)
  const [emailDelivery, setEmailDelivery] = useState<EmailDeliveryRuntimeStatus | null>(null)
  const [error, setError] = useState<string | null>(
    sendError
      ? sendError
      : emailWarning
        ? t("quotes.detail.warning.emailSkipped", { reason: emailWarning })
        : null
  )
  const [acting, setActing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [sendWithoutEmailOpen, setSendWithoutEmailOpen] = useState(false)

  // Edit state
  const [contacts, setContacts] = useState<{ id: string; name: string }[]>([])
  const [catalogItems, setCatalogItems] = useState<CatalogItemOption[]>([])
  const [editContactId, setEditContactId] = useState("")
  const [editExpiryDate, setEditExpiryDate] = useState("")
  const [editNotes, setEditNotes] = useState("")
  const [editTaxRate, setEditTaxRate] = useState("0")
  const [editVatEvidence, setEditVatEvidence] = useState<DraftVatEvidence>({})
  const [editItems, setEditItems] = useState<EditItem[]>([])

  // The page stays mounted when navigating to another quote; drop answers for the previous one.
  const beginRequest = useDocumentResponseGuard(quoteId)

  useEffect(() => {
    const isCurrent = beginRequest(quoteId)
    Promise.all([trpc.quotes.get.query({ id: quoteId }), trpc.settings.get.query()])
      .then(([quoteData, settings]) => {
        if (!isCurrent()) return
        const q = quoteData as unknown as Quote
        setQuote(q)
        setEmailDelivery(settings.emailDelivery)
      })
      .catch(() => {
        if (isCurrent()) setError(t("quotes.detail.error.notFound"))
      })
      .finally(() => {
        if (isCurrent()) setLoading(false)
      })
  }, [beginRequest, quoteId, t])

  async function reloadQuote() {
    const isCurrent = beginRequest(quoteId)
    const updated = await trpc.quotes.get.query({ id: quoteId })
    if (!isCurrent()) return
    setQuote(updated as unknown as Quote)
  }

  /** After a failed send: a refused email is recorded on the quote, so show its new state. */
  async function reloadQuoteAfterFailure() {
    try {
      await reloadQuote()
    } catch {
      // Keep the send error on screen; the quote reloads on the next visit.
    }
  }

  // While the outbox is still delivering the email the quote is frozen; follow it until it settles.
  const emailSending = quote?.lastEmailAttemptOutcome === "sending"
  const pollFailure = usePollWhile(emailSending, reloadQuote)

  function startEditing() {
    if (!quote) return
    setEditContactId(quote.contact.id)
    setEditExpiryDate(new Date(quote.expiryDate).toISOString().split("T")[0])
    setEditNotes(quote.notes ?? "")
    setEditTaxRate(String(quote.items.find((item) => Number(item.taxRate) > 0)?.taxRate ?? 0))
    setEditVatEvidence(draftVatEvidenceSchema.parse(quote.vatEvidence ?? {}))
    setEditItems(
      quote.items.map((item) => ({
        description: item.description,
        quantity: item.quantityInput ?? String(item.quantity),
        unitPrice: item.unitPriceInput ?? String(quote.pricesIncludeTax ? item.unitPriceGross ?? item.unitPrice : item.unitPriceNet ?? item.unitPrice),
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
    if (!quote) return
    setError(null)
    setActing(true)
    const isCurrent = beginRequest(quote.id)
    try {
      const updated = await trpc.quotes.updateV2.mutate({
        id: quote.id,
        contactId: editContactId,
        expiryDate: editExpiryDate,
        notes: editNotes,
        taxRate: editTaxRate,
        vatEvidence: editVatEvidence,
        items: editItems.map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          vat: item.vat,
        })),
      })
      if (!isCurrent()) return
      setQuote(updated as unknown as Quote)
      setEditing(false)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("quotes.detail.error.updateFailed")
      )
    } finally {
      setActing(false)
    }
  }

  async function handleSend(allowSendWithoutEmail = false) {
    if (!quote) return
    setError(null)
    setActing(true)
    try {
      const result = await trpc.quotes.send.mutate({
        id: quote.id,
        allowSendWithoutEmail,
      })
      await reloadQuote()
      setSendWithoutEmailOpen(false)
      if (result.emailSkipReason) {
        setError(
          t("quotes.detail.warning.emailSkipped", {
            reason: result.emailSkipReason,
          })
        )
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("quotes.detail.error.sendFailed")
      )
      await reloadQuoteAfterFailure()
    } finally {
      setActing(false)
    }
  }

  async function handleResendEmail() {
    if (!quote) return
    setError(null)
    setActing(true)
    try {
      await trpc.quotes.resendEmail.mutate({ id: quote.id })
      await reloadQuote()
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("quotes.detail.error.sendFailed")
      )
      await reloadQuoteAfterFailure()
    } finally {
      setActing(false)
    }
  }

  async function handleReject() {
    if (!quote) return
    setActing(true)
    try {
      await trpc.quotes.reject.mutate({ id: quote.id })
      const updated = await trpc.quotes.get.query({ id: quoteId })
      setQuote(updated as unknown as Quote)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("quotes.detail.error.rejectFailed")
      )
    } finally {
      setActing(false)
    }
  }

  const [showAgreementForm, setShowAgreementForm] = useState(false)
  const [agreementValidUntil, setAgreementValidUntil] = useState("")
  async function handleCreateAgreement() {
    if (!quote) return
    setActing(true)
    setError(null)
    try {
      const agreement = await trpc.agreements.createDraftDecimal.mutate({ sourceQuoteId: quote.id, validUntil: agreementValidUntil })
      await navigate({ to: "/agreements/$agreementId/edit", params: { agreementId: agreement.id } })
    } catch (err) {
      setError(err instanceof Error ? err.message : t("agreements.error"))
      setActing(false)
    }
  }

  async function handleConvertToInvoice() {
    if (!quote) return
    setActing(true)
    try {
      const invoice = await trpc.quotes.convertToInvoice.mutate({ id: quote.id })
      navigate({ to: "/invoices/$invoiceId", params: { invoiceId: invoice.id }, search: { emailWarning: undefined } })
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("quotes.detail.error.convertFailed")
      )
      setActing(false)
    }
  }

  async function handleDelete() {
    if (!quote) return
    setActing(true)
    try {
      await trpc.quotes.delete.mutate({ id: quote.id })
      navigate({ to: "/quotes" })
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("quotes.detail.error.deleteFailed")
      )
      setActing(false)
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">{t("quotes.loading")}</p>
      </div>
    )
  }

  if (!quote) {
    return (
      <div className="p-6">
        <p className="text-destructive">
          {error ?? t("quotes.detail.error.notFound")}
        </p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => navigate({ to: "/quotes" })}
        >
          {t("quotes.detail.action.back")}
        </Button>
      </div>
    )
  }

  // Edit mode
  if (editing) {
    const preview = previewDraft({ items: editItems, taxRate: editTaxRate || "0", pricesIncludeTax: quote.pricesIncludeTax ?? false, currency: quote.currency })
    const editSubtotal = Number(preview.result?.net ?? "0")
    const editTaxAmount = Number(preview.result?.tax ?? "0")
    const editTotal = Number(preview.result?.gross ?? "0")

    return (
      <div className="p-6 max-w-3xl">
        <Card>
          <CardHeader>
            <CardTitle>
              {t("quotes.detail.editTitle")} {quote.number}
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
                <Select value={editContactId} onValueChange={setEditContactId}>
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
                <Label htmlFor="editExpiryDate">{t("quotes.new.field.expiryDate")} *</Label>
                <LocalizedDateField
                  id="editExpiryDate"
                  value={editExpiryDate}
                  onChange={setEditExpiryDate}
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
                      value={item.description}
                      onChange={(e) => updateEditItem(index, "description", e.target.value)}
                    />
                    <Input
                      type="number"
                      min="0.000001"
                      step="0.000001"
                      value={item.quantity || ""}
                      onChange={(e) =>
                        updateEditItem(index, "quantity", e.target.value)
                      }
                    />
                    <Input
                      type="number"
                      min="0"
                      step="0.0001"
                      value={item.unitPrice || ""}
                      onChange={(e) =>
                        updateEditItem(index, "unitPrice", e.target.value)
                      }
                    />
                    <span className="text-sm text-right pr-2">
                      {preview.result ? formatCurrency(Number(preview.result?.lines[index]?.[quote.pricesIncludeTax ? "gross" : "net"] ?? "0"), quote.currency, locale) : "—"}
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
            <DocumentVatFields items={editItems} onItemsChange={setEditItems} taxRate={editTaxRate} evidence={editVatEvidence} onEvidenceChange={setEditVatEvidence} />
            <VatGroupPreview {...preview} />
            <div className="flex justify-end">
              <div className="w-64 grid gap-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("docForm.summary.subtotal")}</span>
                  <span>{preview.result ? formatCurrency(editSubtotal, quote.currency, locale) : "—"}</span>
                </div>
                <div className="flex justify-between items-center gap-2">
                  <span className="text-muted-foreground">{t("docForm.summary.tax")}</span>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={editTaxRate || ""}
                      onChange={(e) => { setEditTaxRate(e.target.value); setEditItems((lines) => lines.map((line) => ({ ...line, vat: undefined }))) }}
                      className="w-16 h-7 text-xs"
                    />
                    <span className="text-muted-foreground text-xs">%</span>
                    <span className="ml-auto">{preview.result ? formatCurrency(editTaxAmount, quote.currency, locale) : "—"}</span>
                  </div>
                </div>
                <div className="flex justify-between font-semibold border-t pt-2">
                  <span>{t("docForm.summary.total")}</span>
                  <span>{preview.result ? formatCurrency(editTotal, quote.currency, locale) : "—"}</span>
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
                placeholder={t("quotes.new.notes.placeholder")}
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
              {acting ? t("docForm.action.saving") : t("docForm.action.saveChanges")}
            </Button>
          </CardFooter>
        </Card>
      </div>
    )
  }

  // View mode
  const contact = quote.contact
  const emailAttempt = readEmailDeliveryAttempt({
    lastEmailAttemptAt: quote.lastEmailAttemptAt
      ? new Date(toDateString(quote.lastEmailAttemptAt))
      : null,
    lastEmailAttemptOutcome: quote.lastEmailAttemptOutcome,
    lastEmailAttemptCode: quote.lastEmailAttemptCode,
    lastEmailAttemptMessage: quote.lastEmailAttemptMessage,
  })
  const recipientEmailValid = isValidEmailAddress(contact.email)
  const canResendEmail =
    quote.status === "sent" || quote.status === "accepted" || quote.status === "rejected"
  const canShowDegradedSend =
    quote.status === "draft" && recipientEmailValid && emailDelivery && !emailDelivery.available
  const deliveryStatus = emailAttempt
    ? {
        tone: emailAttempt.lastEmailAttemptOutcome,
        label: t(`quotes.detail.email.status.${emailAttempt.lastEmailAttemptOutcome}`),
        detail: t("quotes.detail.email.lastAttempt", {
          status: t(`quotes.detail.email.status.${emailAttempt.lastEmailAttemptOutcome}`),
          at: formatDate(toDateString(emailAttempt.lastEmailAttemptAt), locale),
        }),
        message:
          emailAttempt.lastEmailAttemptOutcome === "unconfirmed"
            ? t("quotes.detail.email.reason.unconfirmed")
            : emailAttempt.lastEmailAttemptCode === "provider_missing"
            ? t("quotes.detail.email.reason.provider_missing")
            : emailAttempt.lastEmailAttemptCode === "send_failed"
              ? t("quotes.detail.email.reason.send_failed")
              : emailAttempt.lastEmailAttemptOutcome === "sending"
                ? t("quotes.detail.email.reason.sending")
              : emailAttempt.lastEmailAttemptCode === "sent"
                ? t("quotes.detail.email.reason.sent")
                : emailAttempt.lastEmailAttemptMessage,
      }
    : null
  const publicLinkFooter =
    quote.status === "sent" ? (
      <p>{t("quotes.detail.publicLink.pending")}</p>
    ) : quote.status === "rejected" && quote.publicRejectionReason ? (
      <p>
        {t("quotes.detail.publicLink.rejectionReason", {
          reason: quote.publicRejectionReason,
        })}
      </p>
    ) : null
  const recipientFallback =
    !recipientEmailValid ? {
      title: t("quotes.detail.email.fallback.invalidRecipient.title"),
      description: quote.publicViewUrl
        ? t("quotes.detail.email.fallback.invalidRecipient.description")
        : t("quotes.detail.email.fallback.invalidRecipient.descriptionNoLink"),
      copyLabel: quote.publicViewUrl ? t("quotes.detail.publicLink.copy") : undefined,
      onCopy: quote.publicViewUrl
        ? () => {
            navigator.clipboard.writeText(quote.publicViewUrl ?? "")
          }
        : undefined,
      fixAction: (
        <Button asChild variant="outline">
          <Link to="/contacts/$contactId" params={{ contactId: contact.id }}>
            {t("quotes.detail.email.fallback.invalidRecipient.fix")}
          </Link>
        </Button>
      ),
    } : !emailDelivery?.available && canResendEmail && quote.publicViewUrl ? {
      title: t("quotes.detail.email.fallback.providerMissing.title"),
      description: t("quotes.detail.email.fallback.providerMissing.description"),
      copyLabel: t("quotes.detail.publicLink.copy"),
      onCopy: () => {
        navigator.clipboard.writeText(quote.publicViewUrl ?? "")
      },
    } : null

  return (
    <div className="p-6 max-w-3xl">
      {/* Back button and actions */}
      <div className="flex items-center justify-between mb-6">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/quotes" })}>
          <ArrowLeft className="size-4" />
          {t("quotes.detail.action.back")}
        </Button>
        <div className="flex items-center gap-2">
          {/* A draft whose email is still being delivered can no longer be edited or deleted. */}
          {quote.status === "draft" && !emailSending && (
            <>
              <Button variant="outline" size="sm" disabled={acting} onClick={startEditing}>
                <Pencil className="size-4" />
                {t("quotes.detail.action.edit")}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm" disabled={acting}>
                    <Trash2 className="size-4" />
                    {t("quotes.detail.action.delete")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("quotes.delete.title")}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("quotes.delete.description", { number: quote.number })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("quotes.action.cancel")}</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={handleDelete}>
                      {t("quotes.action.delete")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
          {quote.status === "sent" && (
            <>
              <Button variant="outline" size="sm" disabled={acting} onClick={handleReject}>
                <XCircle className="size-4" />
                {acting
                  ? t("quotes.detail.action.updating")
                  : t("quotes.detail.action.markRejected")}
              </Button>
            </>
          )}
          {quote.status === "accepted" && (
            <>
            <Button variant="outline" size="sm" disabled={acting || quote.invoices.length > 0 || !!quote.agreement} onClick={() => setShowAgreementForm(true)}>{t("agreements.createFromQuote")}</Button>
            <Button size="sm" disabled={acting || !!quote.agreement || quote.invoices.length > 0} onClick={handleConvertToInvoice}>
              <ArrowRight className="size-4" />
              {acting
                ? t("quotes.detail.action.converting")
                : t("quotes.detail.action.convertToInvoice")}
            </Button>
            </>
          )}
        </div>
      </div>

      {quote.status === "accepted" && quote.agreement && <p className="mb-4 text-sm">{t("agreements.quoteHasAgreement")} <Link to="/agreements/$agreementId" params={{ agreementId: quote.agreement.id }}>{quote.agreement.title}</Link></p>}
      {quote.status === "accepted" && quote.invoices.length > 0 && <p className="mb-4 text-sm">{t("agreements.quoteHasInvoices")}</p>}
      {showAgreementForm && !quote.agreement && quote.invoices.length === 0 && <div className="border rounded-md p-4 mb-4 grid gap-3 max-w-md">
        <p>{t("agreements.quoteConversionNotice")}</p>
        <Label htmlFor="agreement-valid-until">{t("agreements.validUntil")}</Label>
        <LocalizedDateField id="agreement-valid-until" locale={locale} value={agreementValidUntil} placeholder={t("docForm.selectDate")} onChange={setAgreementValidUntil} required />
        <div className="flex gap-2"><Button disabled={acting || !agreementValidUntil} onClick={handleCreateAgreement}>{t("agreements.save")}</Button><Button variant="outline" disabled={acting} onClick={() => setShowAgreementForm(false)}>{t("agreements.cancel")}</Button></div>
      </div>}
      {error && (
        <p className="text-sm text-destructive mb-4" role="alert">
          {error}
        </p>
      )}

      <div className="mb-4 empty:hidden">
        <ReloadRequiredNotice failure={pollFailure} />
      </div>

      {/* Quote content */}
      <Card>
        <CardContent className="p-6 grid gap-6">
          {/* Header */}
            <div className="flex items-start justify-between">
              <div>
              <h1 className="text-2xl font-bold">
                {t("quotes.detail.title")} {quote.number}
              </h1>
              <div className="mt-1">
                <StatusBadge
                  status={quote.status}
                  label={getQuoteStatusLabel(quote.status, t)}
                />
              </div>
            </div>
            <div className="text-right text-sm text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">
                  {t("quotes.table.issueDate")}:
                </span>{" "}
                {formatDate(quote.issueDate, locale)}
              </p>
              <p>
                <span className="font-medium text-foreground">
                  {t("quotes.table.expiryDate")}:
                </span>{" "}
                {formatDate(quote.expiryDate, locale)}
              </p>
            </div>
          </div>

          {/* Linked invoice(s) for accepted quotes */}
          {quote.status === "accepted" && quote.invoices.length > 0 && (
            <div className="rounded-md border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950 p-3">
              <p className="text-sm font-medium">
                {t("quotes.detail.convertedToInvoice")}{" "}
                {quote.invoices.map((inv) => (
                  <Link
                    key={inv.id}
                    to="/invoices/$invoiceId"
                    params={{ invoiceId: inv.id }}
                    search={{ emailWarning: undefined }}
                    className="text-primary underline underline-offset-4 hover:text-primary/80"
                  >
                    {inv.number}
                  </Link>
                ))}
              </p>
            </div>
          )}

          <EmailDeliveryPanel
            title={t("quotes.detail.email.title")}
            description={t("quotes.detail.email.description")}
            status={deliveryStatus}
            action={
              quote.status === "draft" && recipientEmailValid && emailDelivery?.available
                ? {
                    label: t("quotes.detail.action.send"),
                    pendingLabel: t("quotes.detail.action.sending"),
                    pending: acting,
                    disabled: acting || emailSending,
                    onClick: () => {
                      void handleSend()
                    },
                  }
                : canResendEmail && recipientEmailValid && emailDelivery?.available
                  ? {
                      label: t("quotes.detail.action.resendEmail"),
                      pendingLabel: t("quotes.detail.action.sending"),
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
                    triggerLabel: t("quotes.detail.email.degraded.trigger"),
                    title: t("quotes.detail.email.degraded.title"),
                    description: t("quotes.detail.email.degraded.description"),
                    confirmLabel: t("quotes.detail.email.degraded.confirm"),
                    cancelLabel: t("quotes.detail.email.degraded.cancel"),
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
              quote.publicViewUrl
                ? {
                    title: t("quotes.detail.publicLink.title"),
                    description: t("quotes.detail.publicLink.description"),
                    url: quote.publicViewUrl,
                    copyLabel: t("quotes.detail.publicLink.copy"),
                    onCopy: () => {
                      navigator.clipboard.writeText(quote.publicViewUrl ?? "")
                    },
                    footer: publicLinkFooter,
                  }
                : null
            }
          />

          {/* Quote To */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-1">
              {t("quotes.detail.quoteTo")}
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
                  <TableHead>{t("docForm.column.description")}</TableHead>
                  <TableHead className="text-right w-[80px]">{t("docForm.column.qty")}</TableHead>
                  <TableHead className="text-right w-[120px]">{t("docForm.column.unitPrice")}</TableHead>
                  <TableHead className="text-right w-[120px]">{t("docForm.column.total")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {quote.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.description}</TableCell>
                    <TableCell className="text-right">{item.quantity}</TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(item.unitPrice, quote.currency, locale)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(item.total, quote.currency, locale)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Totals */}
          <div className="flex justify-end">
            <div className="w-64 grid gap-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("docForm.summary.subtotal")}</span>
                <span>{formatCurrency(quote.subtotal, quote.currency, locale)}</span>
              </div>
              {quote.taxAmount > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("docForm.summary.tax")}</span>
                  <span>{formatCurrency(quote.taxAmount, quote.currency, locale)}</span>
                </div>
              )}
              <div className="flex justify-between font-semibold text-base border-t pt-2">
                <span>{t("docForm.summary.total")}</span>
                <span>{formatCurrency(quote.total, quote.currency, locale)}</span>
              </div>
            </div>
          </div>

          {/* Notes */}
          {quote.notes && (
            <div>
              <h3 className="text-sm font-medium text-muted-foreground mb-1">
                {t("docForm.notes")}
              </h3>
              <p className="text-sm whitespace-pre-wrap">{quote.notes}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
