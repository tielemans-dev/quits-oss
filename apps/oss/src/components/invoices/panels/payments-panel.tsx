import { QueryError, QuerySkeleton } from "../../query-state"
import { useQueryRefresh } from "../../../hooks/use-query-refresh"
import { ReceiptsPanel } from "./receipts-panel"
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
type RefundRow = PaymentsView["refunds"][number]

/** Methods a person can record by hand. Stripe payments arrive through the webhook. */
const MANUAL_METHODS: PaymentMethod[] = ["bank_transfer", "card", "cash", "other"]

function methodLabelKey(method: string): TranslationKey {
  switch (method) {
    case "manual":
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
  const [recordOpen, setRecordOpen] = useState<"payment" | "refund" | null>(null)
  const [voiding, setVoiding] = useState<PaymentRow | RefundRow | null>(null)
  const isDraft = invoice.status === "draft"

  const load = useCallback(async () => {
    try {
      setView(await trpc.payments.list.query({ invoiceId: invoice.id }))
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("payments.error.loadFailed"))
    }
  }, [invoice.id, t])

  useQueryRefresh(["payments"], () => { void load() })

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
  const amountRefunded = view?.amountRefunded ?? 0
  const owedToCustomer = view?.owedToCustomer ?? 0

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="grid gap-1.5">
          <CardTitle>{t("payments.title")}</CardTitle>
          <CardDescription>{t("payments.description")}</CardDescription>
        </div>
        {view?.canRecord || view?.canRefund ? (
          <Button size="sm" onClick={() => setRecordOpen(view.canRecord ? "payment" : "refund")}>
            <Plus className="size-4" />
            {t(view.canRecord ? "payments.action.record" : "payments.action.refund")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        <dl className="grid gap-4 rounded-lg border p-4 sm:auto-cols-fr sm:grid-flow-col">
          <SummaryItem label={t("payments.summary.total")} value={money(invoice.total)} />
          <SummaryItem label={t("payments.summary.paid")} value={money(amountPaid)} />
          {amountCredited > 0 ? (
            <SummaryItem label={t("payments.summary.credited")} value={money(amountCredited)} />
          ) : null}
          {amountRefunded > 0 ? (
            <SummaryItem label={t("payments.summary.refunded")} value={money(amountRefunded)} />
          ) : null}
          {/* Credit notes can leave more paid than the invoice charges: then the customer is owed money. */}
          {owedToCustomer > 0 ? (
            <SummaryItem label={t("payments.summary.owedToCustomer")} value={money(owedToCustomer)} emphasis />
          ) : (
            <SummaryItem
              label={t("payments.summary.balanceDue")}
              value={money(balanceDue)}
              emphasis={balanceDue > 0}
            />
          )}
        </dl>
        {owedToCustomer > 0 ? <p className="text-sm text-muted-foreground">{t("payments.refund.hint")}</p> : null}

        {loadError ? (
          <QueryError error={new Error(loadError)} retry={load} />
        ) : !view ? (
          <QuerySkeleton />
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
                {/* Refunds first: each pays back money already received, so they are the latest movements. */}
                {view.refunds.map((refund) => {
                  const voided = Boolean(refund.voidedAt)
                  return (
                    <TableRow key={refund.id} className={voided ? "text-muted-foreground" : undefined}>
                      <TableCell>{formatDate(refund.refundedAt, locale, view.timeZone)}</TableCell>
                      <TableCell>{t("payments.method.refund")}</TableCell>
                      <TableCell className="max-w-[16rem] truncate" title={refund.note ?? undefined}>
                        {refund.note ?? "—"}
                      </TableCell>
                      <TableCell>
                        <PaymentState voidedAt={refund.voidedAt} voidReason={refund.voidReason} />
                      </TableCell>
                      <TableCell className={`num text-right ${voided ? "line-through" : ""}`}>
                        {formatCurrency(-refund.amount, refund.currency, locale)}
                      </TableCell>
                      {view.canVoid ? (
                        <TableCell className="text-right">
                          {voided ? null : (
                            <Button variant="ghost" size="sm" onClick={() => setVoiding(refund)}>
                              {t("payments.action.void")}
                            </Button>
                          )}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  )
                })}
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
                        <PaymentState voidedAt={payment.voidedAt} voidReason={payment.voidReason} />
                      </TableCell>
                      <TableCell className={`num text-right ${voided ? "line-through" : ""}`}>
                        {formatCurrency(payment.amount, payment.currency, locale)}
                      </TableCell>
                      {view.canVoid ? (
                        <TableCell className="text-right">
                          {/* The refunds on a payment are voided before the payment itself. */}
                          {voided || payment.receiptId || amountRefunded > 0 ? null : (
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
        <ReceiptsPanel invoiceId={invoice.id} currency={invoice.currency} today={todayIsoDate(view?.timeZone ?? "UTC")} balanceDue={balanceDue} onChanged={handleChanged} />
      </CardContent>

      {recordOpen ? (
        <RecordPaymentDialog
          invoiceId={invoice.id}
          invoiceNumber={invoice.number ?? ""}
          currency={invoice.currency}
          balanceDue={recordOpen === "refund" ? owedToCustomer : balanceDue}
          timeZone={view?.timeZone ?? "UTC"}
          locale={locale}
          refund={recordOpen === "refund"}
          onClose={() => setRecordOpen(null)}
          onRecorded={handleChanged}
        />
      ) : null}

      {voiding ? (
        <VoidPaymentDialog
          payment={voiding}
          refund={"refundedAt" in voiding}
          locale={locale}
          onClose={() => setVoiding(null)}
          onVoided={handleChanged}
        />
      ) : null}
    </Card>
  )
}

function PaymentState({ voidedAt, voidReason }: { voidedAt: Date | string | null; voidReason: string | null }) {
  const { t } = useI18n()
  if (!voidedAt) return <Badge variant="secondary">{t("payments.state.recorded")}</Badge>
  return (
    <>
      <Badge variant="outline" title={voidReason ?? undefined}>
        {t("payments.state.voided")}
      </Badge>
      {voidReason ? <p className="mt-1 text-xs">{t("payments.state.voidedReason", { reason: voidReason })}</p> : null}
    </>
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

export function RecordPaymentDialog({
  invoiceId,
  invoiceNumber,
  currency,
  balanceDue,
  timeZone,
  locale,
  refund = false,
  onClose,
  onRecorded,
}: {
  invoiceId: string
  invoiceNumber: string
  currency: string
  /** The most the dialog accepts: the balance due, or for a refund what is owed to the customer. */
  balanceDue: number
  timeZone: string
  locale?: string | null
  /** Records money paid back to the customer outside Quits instead. Quits sends no money. */
  refund?: boolean
  onClose: () => void
  onRecorded: () => Promise<void>
}) {
  const { t } = useI18n()
  const [amount, setAmount] = useState(balanceDue.toFixed(2))
  const [paidAt, setPaidAt] = useState(() => todayIsoDate(timeZone))
  const [method, setMethod] = useState<PaymentMethod>("bank_transfer")
  const [reference, setReference] = useState("")
  const [note, setNote] = useState("")
  // A refund retried unchanged keeps its request ID, so an uncertain response is not recorded twice.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const balanceLabel = formatCurrency(balanceDue, currency, locale)
  const changed = () => { setError(null); setRequestId(crypto.randomUUID()) }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const value = Number(amount.replace(",", "."))
    // The form skips native validation, so enforce the input's min="0.01" here: tiny values would store as 0.00.
    if (!Number.isFinite(value) || value < 0.01 || !hasAtMostTwoDecimals(value)) {
      setError(t("payments.record.error.amount"))
      return
    }
    if (value > balanceDue + 1e-9) {
      setError(refund
        ? t("payments.refund.error.exceedsOwed", { owed: balanceLabel })
        : t("payments.record.error.overpayment", { balance: balanceLabel }))
      return
    }
    if (!paidAt || paidAt > todayIsoDate(timeZone)) {
      setError(t(refund ? "payments.refund.error.date" : "payments.record.error.date"))
      return
    }

    setError(null)
    setSubmitting(true)
    try {
      const details = { invoiceId, amount: value, note: note.trim() || undefined }
      await (refund
        ? trpc.payments.refund.mutate({ ...details, requestId, refundedAt: paidAt })
        : trpc.payments.record.mutate({ ...details, paidAt, method, reference: reference.trim() || undefined }))
      await onRecorded()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t(refund ? "payments.refund.error.failed" : "payments.record.error.failed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open && !submitting ? onClose() : undefined)}>
      <DialogContent>
        <form noValidate onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t(refund ? "payments.refund.title" : "payments.record.title")}</DialogTitle>
            <DialogDescription>
              {refund
                ? t("payments.refund.description", { owed: balanceLabel })
                : t("payments.record.description", { number: invoiceNumber, balance: balanceLabel })}
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
                onChange={(event) => { setAmount(event.target.value); changed() }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="payment-date">{t(refund ? "payments.refund.date" : "payments.record.date")}</Label>
              <LocalizedDateField
                id="payment-date"
                value={paidAt}
                onChange={(value) => { setPaidAt(value); changed() }}
                locale={locale}
                placeholder={t("payments.record.datePlaceholder")}
                required
              />
            </div>
          </div>

          <div className="grid gap-2" hidden={refund}>
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

          <div className="grid gap-2" hidden={refund}>
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
              onChange={(event) => { setNote(event.target.value); changed() }}
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
              {submitting ? t("payments.action.recording") : t(refund ? "payments.action.refund" : "payments.action.record")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function VoidPaymentDialog({
  payment,
  refund = false,
  locale,
  onClose,
  onVoided,
}: {
  payment: Pick<PaymentRow, "id" | "amount" | "currency">
  /** The row is a refund: voiding it puts the amount back on what the customer is owed. */
  refund?: boolean
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
      await (refund
        ? trpc.payments.voidRefund.mutate({ refundId: payment.id, reason: reason.trim() })
        : trpc.payments.void.mutate({ paymentId: payment.id, reason: reason.trim() }))
      await onVoided()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t(refund ? "payments.refund.void.error.failed" : "payments.void.error.failed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open && !submitting ? onClose() : undefined)}>
      <DialogContent>
        <form noValidate onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t(refund ? "payments.refund.void.title" : "payments.void.title")}</DialogTitle>
            <DialogDescription>
              {t(refund ? "payments.refund.void.description" : "payments.void.description", {
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
              onChange={(event) => { setReason(event.target.value); setError(null) }}
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
