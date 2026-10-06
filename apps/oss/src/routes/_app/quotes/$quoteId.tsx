import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useState, useEffect } from "react"
import { trpc } from "../../../trpc/client"
import { usePollWhile } from "../../../hooks/use-poll-while"
import { applyCatalogItemToLineItem, type CatalogItemOption } from "../../../lib/catalog"
import {
  readEmailDeliveryAttempt,
  type EmailDeliveryRuntimeStatus,
} from "../../../lib/email-delivery"
import { LocalizedDateField } from "../../../components/localized-date-field"
import { EmailDeliveryPanel } from "../../../components/documents/email-delivery-panel"
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
  invoices: { id: string; number: string }[]
}

type EditItem = {
  description: string
  quantity: number
  unitPrice: number
  catalogItemId?: string
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
  const [editTaxRate, setEditTaxRate] = useState(0)
  const [editItems, setEditItems] = useState<EditItem[]>([])

  useEffect(() => {
    Promise.all([trpc.quotes.get.query({ id: quoteId }), trpc.settings.get.query()])
      .then(([quoteData, settings]) => {
        const q = quoteData as unknown as Quote
        setQuote(q)
        setEmailDelivery(settings.emailDelivery)
      })
      .catch(() => setError(t("quotes.detail.error.notFound")))
      .finally(() => setLoading(false))
  }, [quoteId, t])

  async function reloadQuote() {
    const updated = await trpc.quotes.get.query({ id: quoteId })
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
  usePollWhile(emailSending, reloadQuote)

  function startEditing() {
    if (!quote) return
    setEditContactId(quote.contact.id)
    setEditExpiryDate(new Date(quote.expiryDate).toISOString().split("T")[0])
    setEditNotes(quote.notes ?? "")
    setEditTaxRate(
      quote.subtotal > 0
        ? Math.round((quote.taxAmount / quote.subtotal) * 10000) / 100
        : 0
    )
    setEditItems(
      quote.items.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
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

  function updateEditItem(index: number, field: keyof EditItem, value: string | number) {
    setEditItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: value } : item))
    )
  }

  function addEditItem() {
    setEditItems((prev) => [...prev, { description: "", quantity: 1, unitPrice: 0 }])
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
    try {
      const updated = await trpc.quotes.update.mutate({
        id: quote.id,
        contactId: editContactId,
        expiryDate: editExpiryDate,
        notes: editNotes,
        taxRate: editTaxRate,
        items: editItems.map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
      })
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
    const editSubtotal = editItems.reduce(
      (sum, item) => sum + item.quantity * item.unitPrice,
      0
    )
    const editTaxAmount = editSubtotal * editTaxRate / 100
    const editTotal = editSubtotal + editTaxAmount

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
                      min="0.01"
                      step="0.01"
                      value={item.quantity || ""}
                      onChange={(e) =>
                        updateEditItem(index, "quantity", parseFloat(e.target.value) || 0)
                      }
                    />
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={item.unitPrice || ""}
                      onChange={(e) =>
                        updateEditItem(index, "unitPrice", parseFloat(e.target.value) || 0)
                      }
                    />
                    <span className="text-sm text-right pr-2">
                      {formatCurrency(item.quantity * item.unitPrice, quote.currency, locale)}
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
            <div className="flex justify-end">
              <div className="w-64 grid gap-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("docForm.summary.subtotal")}</span>
                  <span>{formatCurrency(editSubtotal, quote.currency, locale)}</span>
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
                      onChange={(e) => setEditTaxRate(parseFloat(e.target.value) || 0)}
                      className="w-16 h-7 text-xs"
                    />
                    <span className="text-muted-foreground text-xs">%</span>
                    <span className="ml-auto">{formatCurrency(editTaxAmount, quote.currency, locale)}</span>
                  </div>
                </div>
                <div className="flex justify-between font-semibold border-t pt-2">
                  <span>{t("docForm.summary.total")}</span>
                  <span>{formatCurrency(editTotal, quote.currency, locale)}</span>
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
          {quote.status === "accepted" && quote.invoices.length === 0 && (
            <Button size="sm" disabled={acting} onClick={handleConvertToInvoice}>
              <ArrowRight className="size-4" />
              {acting
                ? t("quotes.detail.action.converting")
                : t("quotes.detail.action.convertToInvoice")}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive mb-4" role="alert">
          {error}
        </p>
      )}

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
