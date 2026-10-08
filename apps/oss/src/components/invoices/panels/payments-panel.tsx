import { useCallback, useEffect, useState } from "react"
import { Plus } from "lucide-react"
import type { PaymentMethod } from "@quits/contracts/payments"
import { trpc } from "../../../trpc/client"
import { useI18n } from "../../../lib/i18n/react"
import type { TranslationKey } from "../../../lib/i18n/messages"
import { formatCurrency, formatDate } from "../../../lib/i18n/format"
import { LocalizedDateField } from "../../localized-date-field"
import { Badge } from "../../ui/badge"
import { Button } from "../../ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog"
import { Input } from "../../ui/input"
import { Label } from "../../ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../ui/table"
import { Textarea } from "../../ui/textarea"
import type { InvoicePanelProps } from "./types"

type PaymentsView = Awaited<ReturnType<typeof trpc.payments.list.query>>
type PaymentRow = PaymentsView["payments"][number]

/** Methods a person can record by hand. Stripe payments arrive through the webhook. */
const MANUAL_METHODS: PaymentMethod[] = ["bank_transfer", "card", "cash", "other"]

function methodLabelKey(method: string): TranslationKey {
  switch (method) {
    case "bank_transfer":
    case "card":
    case "cash":
    case "stripe":
      return `payments.method.${method}`
    default:
      return "payments.method.other"
  }
}

/** Today's calendar date (`YYYY-MM-DD`) in the organization's time zone, which the server uses. */
function todayIsoDate(timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date())
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? ""
    return `${part("year")}-${part("month")}-${part("day")}`
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

function hasAtMostTwoDecimals(value: number) {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6
}

/** Owned by the payments feature. */
export function InvoicePaymentsPanel({ invoice, locale, onChanged }: InvoicePanelProps) {
  const { t } = useI18n()
  const [view, setView] = useState<PaymentsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [recordOpen, setRecordOpen] = useState(false)
  const [voiding, setVoiding] = useState<PaymentRow | null>(null)
  const isDraft = invoice.status === "draft"

  const load = useCallback(async () => {
    try {
      setView(await trpc.payments.list.query({ invoiceId: invoice.id }))
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("payments.error.loadFailed"))
    }
  }, [invoice.id, t])

  useEffect(() => {
    if (isDraft) return
    void load()
    // Reload whenever the invoice's settlement changes, e.g. after "Mark as paid".
  }, [load, isDraft, invoice.status, invoice.amountPaid, invoice.amountCredited])

  async function handleChanged() {
    await Promise.all([load(), onChanged()])
  }

  if (isDraft) {
    return null
  }

  const money = (amount: number) => formatCurrency(amount, invoice.currency, locale)
  const balanceDue = view?.balanceDue ?? invoice.balanceDue
  const amountPaid = view?.amountPaid ?? invoice.amountPaid
  const amountCredited = view?.amountCredited ?? invoice.amountCredited

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="grid gap-1.5">
          <CardTitle>{t("payments.title")}</CardTitle>
          <CardDescription>{t("payments.description")}</CardDescription>
        </div>
        {view?.canRecord ? (
          <Button size="sm" onClick={() => setRecordOpen(true)}>
            <Plus className="size-4" />
            {t("payments.action.record")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-4">
        <dl className="grid gap-4 rounded-lg border p-4 sm:grid-cols-4">
          <SummaryItem label={t("payments.summary.total")} value={money(invoice.total)} />
          <SummaryItem label={t("payments.summary.paid")} value={money(amountPaid)} />
          {amountCredited > 0 ? (
            <SummaryItem label={t("payments.summary.credited")} value={money(amountCredited)} />
          ) : null}
          <SummaryItem
            label={t("payments.summary.balanceDue")}
            value={money(balanceDue)}
            emphasis={balanceDue > 0}
          />
        </dl>

        {loadError ? (
          <p className="text-sm text-destructive" role="alert">
            {loadError}
          </p>
        ) : !view ? (
          <p className="text-sm text-muted-foreground">{t("payments.loading")}</p>
        ) : view.payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("payments.empty")}</p>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("payments.table.date")}</TableHead>
                  <TableHead>{t("payments.table.method")}</TableHead>
                  <TableHead>{t("payments.table.reference")}</TableHead>
                  <TableHead>{t("payments.table.status")}</TableHead>
                  <TableHead className="text-right">{t("payments.table.amount")}</TableHead>
                  {view.canVoid ? (
                    <TableHead className="w-[1%] text-right">
                      <span className="sr-only">{t("payments.table.actions")}</span>
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.payments.map((payment) => {
                  const voided = Boolean(payment.voidedAt)
                  return (
                    <TableRow key={payment.id} className={voided ? "text-muted-foreground" : undefined}>
                      <TableCell>{formatDate(payment.paidAt, locale, view.timeZone)}</TableCell>
                      <TableCell>{t(methodLabelKey(payment.method))}</TableCell>
                      <TableCell className="max-w-[16rem] truncate" title={payment.note ?? undefined}>
                        {payment.reference ?? "—"}
                      </TableCell>
                      <TableCell>
                        {voided ? (
                          <Badge variant="outline" title={payment.voidReason ?? undefined}>
                            {t("payments.state.voided")}
                          </Badge>
                        ) : (
                          <Badge variant="secondary">{t("payments.state.recorded")}</Badge>
                        )}
                        {voided && payment.voidReason ? (
                          <p className="mt-1 text-xs">
                            {t("payments.state.voidedReason", { reason: payment.voidReason })}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className={`num text-right ${voided ? "line-through" : ""}`}>
                        {formatCurrency(payment.amount, payment.currency, locale)}
                      </TableCell>
                      {view.canVoid ? (
                        <TableCell className="text-right">
                          {voided ? null : (
                            <Button variant="ghost" size="sm" onClick={() => setVoiding(payment)}>
                              {t("payments.action.void")}
                            </Button>
                          )}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {recordOpen ? (
        <RecordPaymentDialog
          invoiceId={invoice.id}
          invoiceNumber={invoice.number}
          currency={invoice.currency}
          balanceDue={balanceDue}
          timeZone={view?.timeZone ?? "UTC"}
          locale={locale}
          onClose={() => setRecordOpen(false)}
          onRecorded={handleChanged}
        />
      ) : null}

      {voiding ? (
        <VoidPaymentDialog
          payment={voiding}
          locale={locale}
          onClose={() => setVoiding(null)}
          onVoided={handleChanged}
        />
      ) : null}
    </Card>
  )
}

function SummaryItem({
  label,
  value,
  emphasis = false,
}: {
  label: string
  value: string
  emphasis?: boolean
}) {
  return (
    <div className="grid gap-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={emphasis ? "num text-base font-semibold" : "num text-sm font-medium"}>
        {value}
      </dd>
    </div>
  )
}

function RecordPaymentDialog({
  invoiceId,
  invoiceNumber,
  currency,
  balanceDue,
  timeZone,
  locale,
  onClose,
  onRecorded,
}: {
  invoiceId: string
  invoiceNumber: string
  currency: string
  balanceDue: number
  timeZone: string
  locale?: string | null
  onClose: () => void
  onRecorded: () => Promise<void>
}) {
  const { t } = useI18n()
  const [amount, setAmount] = useState(balanceDue.toFixed(2))
  const [paidAt, setPaidAt] = useState(() => todayIsoDate(timeZone))
  const [method, setMethod] = useState<PaymentMethod>("bank_transfer")
  const [reference, setReference] = useState("")
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const balanceLabel = formatCurrency(balanceDue, currency, locale)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const value = Number(amount.replace(",", "."))
    if (!Number.isFinite(value) || value <= 0 || !hasAtMostTwoDecimals(value)) {
      setError(t("payments.record.error.amount"))
      return
    }
    if (value > balanceDue + 1e-9) {
      setError(t("payments.record.error.overpayment", { balance: balanceLabel }))
      return
    }
    if (!paidAt || paidAt > todayIsoDate(timeZone)) {
      setError(t("payments.record.error.date"))
      return
    }

    setError(null)
    setSubmitting(true)
    try {
      await trpc.payments.record.mutate({
        invoiceId,
        amount: value,
        paidAt,
        method,
        reference: reference.trim() || undefined,
        note: note.trim() || undefined,
      })
      await onRecorded()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t("payments.record.error.failed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open && !submitting ? onClose() : undefined)}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("payments.record.title")}</DialogTitle>
            <DialogDescription>
              {t("payments.record.description", { number: invoiceNumber, balance: balanceLabel })}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="payment-amount">{t("payments.record.amount", { currency })}</Label>
              <Input
                id="payment-amount"
                inputMode="decimal"
                type="number"
                min="0.01"
                step="0.01"
                max={balanceDue}
                required
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="payment-date">{t("payments.record.date")}</Label>
              <LocalizedDateField
                id="payment-date"
                value={paidAt}
                onChange={setPaidAt}
                locale={locale}
                placeholder={t("payments.record.datePlaceholder")}
                required
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="payment-method">{t("payments.record.method")}</Label>
            <Select value={method} onValueChange={(value) => setMethod(value as PaymentMethod)}>
              <SelectTrigger id="payment-method" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MANUAL_METHODS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {t(methodLabelKey(option))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="payment-reference">{t("payments.record.reference")}</Label>
            <Input
              id="payment-reference"
              maxLength={200}
              placeholder={t("payments.record.referencePlaceholder")}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="payment-note">{t("payments.record.note")}</Label>
            <Textarea
              id="payment-note"
              maxLength={2000}
              rows={2}
              placeholder={t("payments.record.notePlaceholder")}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>
              {t("payments.action.cancel")}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? t("payments.action.recording") : t("payments.action.record")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function VoidPaymentDialog({
  payment,
  locale,
  onClose,
  onVoided,
}: {
  payment: PaymentRow
  locale?: string | null
  onClose: () => void
  onVoided: () => Promise<void>
}) {
  const { t } = useI18n()
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!reason.trim()) {
      setError(t("payments.void.error.reason"))
      return
    }

    setError(null)
    setSubmitting(true)
    try {
      await trpc.payments.void.mutate({ paymentId: payment.id, reason: reason.trim() })
      await onVoided()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t("payments.void.error.failed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open && !submitting ? onClose() : undefined)}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("payments.void.title")}</DialogTitle>
            <DialogDescription>
              {t("payments.void.description", {
                amount: formatCurrency(payment.amount, payment.currency, locale),
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="void-reason">{t("payments.void.reason")}</Label>
            <Textarea
              id="void-reason"
              required
              maxLength={500}
              rows={3}
              placeholder={t("payments.void.reasonPlaceholder")}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>
              {t("payments.action.cancel")}
            </Button>
            <Button type="submit" variant="destructive" disabled={submitting}>
              {submitting ? t("payments.action.voiding") : t("payments.action.void")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
