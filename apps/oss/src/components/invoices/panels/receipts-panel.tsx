import { useCallback, useEffect, useState } from "react"
import { settlementEvidenceSchema } from "@quits/contracts/payments"
import type {
  ReceiptActionInput,
  ReceiptAllocateInput,
  ReceiptRecordInput,
} from "@quits/contracts/payments"
import { trpc } from "../../../trpc/client"
import { useI18n } from "../../../lib/i18n/react"
import { LocalizedDateField } from "../../localized-date-field"
import { Button } from "../../ui/button"
import { Input } from "../../ui/input"
import { Label } from "../../ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog"

type View = Awaited<ReturnType<typeof trpc.payments.receipts.query>>
type Receipt = View["receipts"][number]
type Preview = Awaited<ReturnType<typeof trpc.payments.previewAllocation.query>>
const id = () => crypto.randomUUID()

function evidenceHref(value: string) {
  const parsed = settlementEvidenceSchema.shape.evidence.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** The invoice's customer owns the receipt, including any amount not yet allocated. */
export function ReceiptsPanel({
  invoiceId,
  currency,
  today,
  balanceDue,
  onChanged,
}: {
  invoiceId: string
  currency: string
  today: string
  balanceDue: number
  onChanged: () => Promise<void>
}) {
  const { t } = useI18n()
  const [view, setView] = useState<View | null>(null)
  const [error, setError] = useState("")
  const [creating, setCreating] = useState(false)
  const [allocating, setAllocating] = useState<Receipt | null>(null)
  const [changing, setChanging] = useState<Receipt | null>(null)
  const load = useCallback(async () => {
    try {
      setView(await trpc.payments.receipts.query({ invoiceId }))
      setError("")
    } catch (err) {
      setError(err instanceof Error ? err.message : t("payments.error.loadFailed"))
    }
  }, [invoiceId, t])
  useEffect(() => {
    void load()
  }, [load, balanceDue])
  async function changed() {
    await Promise.all([load(), onChanged()])
  }
  return (
    <section className="grid gap-3 border-t pt-4" aria-label={t("payments.receipts.title")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{t("payments.receipts.title")}</h3>
        {view?.canCreate ? (
          <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
            {t("payments.receipts.record")}
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{t("payments.receipts.description")}</p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {view?.receipts.map((receipt) => (
        <div key={receipt.id} className="grid gap-2 rounded-md border p-3">
          <div className="flex flex-wrap justify-between gap-2">
            <strong>{receipt.reference}</strong>
            <span>{receipt.currency}</span>
          </div>
          <p className="text-sm">
            {t("payments.receipts.values", {
              gross: receipt.gross,
              fee: receipt.fee,
              net: receipt.net,
              available: receipt.available,
            })}
          </p>
          <p className="text-sm">
            {t("payments.receipts.movements", {
              allocated: receipt.allocated,
              refunded: receipt.refunded,
            })}
          </p>
          <a className="text-sm underline" href={evidenceHref(receipt.evidence)} target="_blank" rel="noreferrer">
            {receipt.reason}
          </a>
          {receipt.customerCredit ? (
            <p className="text-sm">{t("payments.receipts.customerCredit")}</p>
          ) : null}
          {receipt.reversed ? (
            <p>{t("payments.state.voided")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {view.canCreate && Number(receipt.available) > 0 ? (
                <Button size="sm" variant="outline" onClick={() => setAllocating(receipt)}>
                  {t("payments.receipts.allocate")}
                </Button>
              ) : null}
              {view.canReverse ? (
                <Button size="sm" variant="ghost" onClick={() => setChanging(receipt)}>
                  {t("payments.receipts.change")}
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ))}
      {creating && view ? (
        <RecordReceiptDialog
          contactId={view.contactId}
          currency={currency}
          today={today}
          onClose={() => setCreating(false)}
          onChanged={changed}
        />
      ) : null}
      {allocating && view ? (
        <AllocateDialog
          receipt={allocating}
          invoices={view.invoices}
          onClose={() => setAllocating(null)}
          onChanged={changed}
        />
      ) : null}
      {changing ? (
        <ChangeDialog receipt={changing} onClose={() => setChanging(null)} onChanged={changed} />
      ) : null}
    </section>
  )
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required = true,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  required?: boolean
}) {
  return (
    <Label className="grid gap-2">
      {label}
      <Input
        type={type}
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
      />
    </Label>
  )
}
function EvidenceFields({
  reason,
  evidence,
  onReason,
  onEvidence,
}: {
  reason: string
  evidence: string
  onReason: (value: string) => void
  onEvidence: (value: string) => void
}) {
  const { t } = useI18n()
  return (
    <>
      <Field label={t("payments.void.reason")} value={reason} onChange={onReason} />
      <Field
        label={t("payments.receipts.evidence")}
        value={evidence}
        onChange={onEvidence}
        type="url"
      />
    </>
  )
}
function CustomerCreditPreview({
  classification,
  label,
}: {
  classification: Preview["customerCreditBefore"]
  label: string
}) {
  const { t } = useI18n()
  return (
    <div className="grid gap-1">
      <p className="font-medium">{label}</p>
      <p>{classification.reason ?? t("payments.receipts.unclassified")}</p>
      {classification.evidence ? (
        <a className="underline" href={evidenceHref(classification.evidence)} target="_blank" rel="noreferrer">
          {classification.evidence}
        </a>
      ) : null}
    </div>
  )
}

function ReceiptDialog({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  const { t } = useI18n()
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("payments.receipts.policy")}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

function RecordReceiptDialog({
  contactId,
  currency,
  today,
  onClose,
  onChanged,
}: {
  contactId: string
  currency: string
  today: string
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const { t, locale } = useI18n()
  const [form, setForm] = useState<ReceiptRecordInput>(() => ({
    requestId: id(),
    contactId,
    currency,
    netAmount: "",
    feeAmount: "0",
    paidAt: today,
    method: "bank_transfer",
    reference: "",
    reason: "",
    evidence: "",
  }))
  const [feeReason, setFeeReason] = useState("")
  const [feeEvidence, setFeeEvidence] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [reviewed, setReviewed] = useState(false)
  function set(key: keyof ReceiptRecordInput, value: string) {
    setForm((current) => ({ ...current, [key]: value, requestId: id() }))
    setReviewed(false)
  }
  const gross = (
    (Math.round(Number(form.netAmount) * 100) + Math.round(Number(form.feeAmount) * 100)) /
    100
  ).toFixed(2)
  return (
    <ReceiptDialog
      title={t("payments.receipts.record")}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        className="grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!reviewed) {
            setReviewed(true)
            return
          }
          setBusy(true)
          setError("")
          try {
            await trpc.payments.recordReceipt.mutate({
              ...form,
              ...(Number(form.feeAmount) > 0
                ? { feeEvidence: { reason: feeReason, evidence: feeEvidence } }
                : {}),
            })
            await onChanged()
            onClose()
          } catch (err) {
            setError(err instanceof Error ? err.message : t("payments.record.error.failed"))
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field
          label={t("payments.record.reference")}
          value={form.reference}
          onChange={(v) => set("reference", v)}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t("payments.receipts.currency")}
            value={form.currency}
            onChange={(v) => set("currency", v.toUpperCase())}
          />
          <div className="grid gap-2">
            <Label htmlFor="receipt-date">{t("payments.record.date")}</Label>
            <LocalizedDateField
              id="receipt-date"
              value={form.paidAt}
              onChange={(v) => set("paidAt", v)}
              locale={locale}
              placeholder={t("payments.record.datePlaceholder")}
              required
            />
          </div>
          <Field
            label={t("payments.receipts.net")}
            value={form.netAmount}
            onChange={(v) => set("netAmount", v)}
          />
          <Field
            label={t("payments.receipts.fee")}
            value={form.feeAmount}
            onChange={(v) => set("feeAmount", v)}
          />
        </div>
        <Label className="grid gap-2">
          {t("payments.record.method")}
          <select
            className="rounded-md border p-2"
            value={form.method}
            onChange={(e) => set("method", e.target.value)}
          >
            <option value="bank_transfer">{t("payments.method.bank_transfer")}</option>
            <option value="card">{t("payments.method.card")}</option>
            <option value="cash">{t("payments.method.cash")}</option>
            <option value="other">{t("payments.method.other")}</option>
          </select>
        </Label>
        <EvidenceFields
          reason={form.reason}
          evidence={form.evidence}
          onReason={(v) => set("reason", v)}
          onEvidence={(v) => set("evidence", v)}
        />
        {Number(form.feeAmount) > 0 ? (
          <fieldset className="grid gap-3 rounded-md border p-3">
            <legend>{t("payments.receipts.fee")}</legend>
            <EvidenceFields
              reason={feeReason}
              evidence={feeEvidence}
              onReason={(v) => {
                setFeeReason(v)
                setForm((current) => ({ ...current, requestId: id() }))
                setReviewed(false)
              }}
              onEvidence={(v) => {
                setFeeEvidence(v)
                setForm((current) => ({ ...current, requestId: id() }))
                setReviewed(false)
              }}
            />
          </fieldset>
        ) : null}
        {reviewed ? (
          <p role="status">
            {t("payments.receipts.values", {
              gross,
              fee: form.feeAmount,
              net: form.netAmount,
              available: gross,
            })}{" "}
            {form.currency}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={busy}>
          {reviewed ? t("payments.receipts.confirm") : t("payments.receipts.preview")}
        </Button>
      </form>
    </ReceiptDialog>
  )
}

function AllocateDialog({
  receipt,
  invoices,
  onClose,
  onChanged,
}: {
  receipt: Receipt
  invoices: View["invoices"]
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const { t } = useI18n()
  const [form, setForm] = useState<ReceiptAllocateInput>(() => ({
    requestId: id(),
    receiptId: receipt.id,
    reason: "",
    evidence: "",
    allocations: [],
  }))
  const [amounts, setAmounts] = useState<Record<string, { invoice: string; receipt: string }>>({})
  const [exchangeReason, setExchangeReason] = useState("")
  const [exchangeEvidence, setExchangeEvidence] = useState("")
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  function resetPreview() {
    setPreview(null)
    setForm((current) => ({ ...current, requestId: id() }))
  }
  const foreign = invoices.some(
    (invoice) => invoice.currency !== receipt.currency && Number(amounts[invoice.id]?.invoice) > 0,
  )
  const input = {
    ...form,
    allocations: invoices
      .filter((invoice) => Number(amounts[invoice.id]?.invoice) > 0)
      .map((invoice) => ({
        invoiceId: invoice.id,
        invoiceAmount: amounts[invoice.id].invoice,
        receiptAmount:
          invoice.currency === receipt.currency
            ? amounts[invoice.id].invoice
            : amounts[invoice.id].receipt,
        ...(invoice.currency !== receipt.currency
          ? { exchangeEvidence: { reason: exchangeReason, evidence: exchangeEvidence } }
          : {}),
      })),
  }
  return (
    <ReceiptDialog
      title={t("payments.receipts.allocate")}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        className="grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError("")
          try {
            if (!preview) setPreview(await trpc.payments.previewAllocation.query(input))
            else {
              await trpc.payments.allocateReceipt.mutate({
                ...input,
                previewToken: preview.previewToken,
              })
              await onChanged()
              onClose()
            }
          } catch (err) {
            if (
              (err as { data?: { reason?: string } }).data?.reason === "settlement_preview_changed"
            )
              resetPreview()
            setError(err instanceof Error ? err.message : t("payments.record.error.failed"))
          } finally {
            setBusy(false)
          }
        }}
      >
        <p>
          {t("payments.receipts.available", {
            amount: receipt.available,
            currency: receipt.currency,
          })}
        </p>
        {invoices
          .filter((invoice) => Number(invoice.balanceDue) > 0)
          .map((invoice) => (
            <fieldset key={invoice.id} className="grid gap-2 rounded-md border p-3">
              <legend>
                {invoice.number}: {invoice.balanceDue} {invoice.currency}
              </legend>
              <Field
                label={t("payments.record.amount", { currency: invoice.currency })}
                value={amounts[invoice.id]?.invoice ?? ""}
                required={false}
                onChange={(value) => {
                  setAmounts((current) => ({
                    ...current,
                    [invoice.id]: { receipt: current[invoice.id]?.receipt ?? "", invoice: value },
                  }))
                  resetPreview()
                }}
              />
              {invoice.currency !== receipt.currency ? (
                <Field
                  label={t("payments.receipts.consumed", { currency: receipt.currency })}
                  value={amounts[invoice.id]?.receipt ?? ""}
                  required={false}
                  onChange={(value) => {
                    setAmounts((current) => ({
                      ...current,
                      [invoice.id]: { invoice: current[invoice.id]?.invoice ?? "", receipt: value },
                    }))
                    resetPreview()
                  }}
                />
              ) : null}
            </fieldset>
          ))}
        <EvidenceFields
          reason={form.reason}
          evidence={form.evidence}
          onReason={(reason) => {
            setForm((current) => ({ ...current, reason }))
            resetPreview()
          }}
          onEvidence={(evidence) => {
            setForm((current) => ({ ...current, evidence }))
            resetPreview()
          }}
        />
        {foreign ? (
          <fieldset className="grid gap-3">
            <legend>{t("payments.receipts.exchange")}</legend>
            <EvidenceFields
              reason={exchangeReason}
              evidence={exchangeEvidence}
              onReason={(v) => {
                setExchangeReason(v)
                resetPreview()
              }}
              onEvidence={(v) => {
                setExchangeEvidence(v)
                resetPreview()
              }}
            />
          </fieldset>
        ) : null}
        {preview ? (
          <div role="status" className="grid gap-2 rounded-md border p-3">
            <CustomerCreditPreview
              classification={preview.customerCreditBefore}
              label={t("payments.receipts.classificationBefore")}
            />
            {preview.allocations.map((a) => (
              <p key={a.invoiceId}>
                {t("payments.receipts.balancePreview", {
                  number: a.number,
                  before: a.before,
                  after: a.after,
                  currency: a.currency,
                })}
              </p>
            ))}
            <p>
              {t("payments.receipts.available", {
                amount: preview.availableAfter,
                currency: receipt.currency,
              })}
            </p>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={busy}>
          {preview ? t("payments.receipts.confirm") : t("payments.receipts.preview")}
        </Button>
      </form>
    </ReceiptDialog>
  )
}

function ChangeDialog({
  receipt,
  onClose,
  onChanged,
}: {
  receipt: Receipt
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const { t } = useI18n()
  const [action, setAction] = useState("refund")
  const [targetId, setTargetId] = useState("")
  const [amount, setAmount] = useState("")
  const [reason, setReason] = useState("")
  const [evidence, setEvidence] = useState("")
  const [requestId, setRequestId] = useState(id)
  const [preview, setPreview] = useState<Awaited<
    ReturnType<typeof trpc.payments.previewReceiptChange.query>
  > | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const targets =
    action === "reverse_allocation"
      ? receipt.allocations.filter((a) => !a.reversed)
      : receipt.refunds.filter((r) => !r.reversed)
  return (
    <ReceiptDialog
      title={t("payments.receipts.change")}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        className="grid gap-4"
        onChange={() => {
          setPreview(null)
          setRequestId(id())
        }}
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError("")
          const common = { requestId, reason, evidence }
          const input: ReceiptActionInput =
            action === "reverse_allocation"
              ? { ...common, action, paymentId: targetId }
              : action === "reverse_refund"
                ? { ...common, action, refundId: targetId }
                : action === "refund"
                  ? { ...common, action, receiptId: receipt.id, amount }
                  : {
                      ...common,
                      action: action === "customer_credit" ? "customer_credit" : "reverse_receipt",
                      receiptId: receipt.id,
                    }
          try {
            if (!preview) setPreview(await trpc.payments.previewReceiptChange.query(input))
            else {
              await trpc.payments.changeReceipt.mutate({
                ...input,
                previewToken: preview.previewToken,
              })
              await onChanged()
              onClose()
            }
          } catch (err) {
            if (
              (err as { data?: { reason?: string } }).data?.reason === "settlement_preview_changed"
            ) {
              setPreview(null)
              setRequestId(id())
            }
            setError(err instanceof Error ? err.message : t("payments.record.error.failed"))
          } finally {
            setBusy(false)
          }
        }}
      >
        <Label className="grid gap-2">
          {t("payments.receipts.change")}
          <select
            className="rounded-md border p-2"
            value={action}
            onChange={(e) => {
              setAction(e.target.value)
              setTargetId("")
            }}
          >
            <option value="refund">{t("payments.receipts.refund")}</option>
            <option value="customer_credit">{t("payments.receipts.customerCredit")}</option>
            <option value="reverse_allocation">{t("payments.receipts.reverseAllocation")}</option>
            <option value="reverse_refund">{t("payments.receipts.reverseRefund")}</option>
            <option value="reverse_receipt">{t("payments.receipts.reverseReceipt")}</option>
          </select>
        </Label>
        {action.startsWith("reverse_") && action !== "reverse_receipt" ? (
          <Label className="grid gap-2">
            {t("payments.receipts.entry")}
            <select
              className="rounded-md border p-2"
              required
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
            >
              <option value="">{t("payments.receipts.select")}</option>
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {"invoiceNumber" in target ? String(target.invoiceNumber) : target.id}:{" "}
                  {target.amount}{" "}
                  {"currency" in target ? String(target.currency) : receipt.currency}
                </option>
              ))}
            </select>
          </Label>
        ) : null}
        {action === "refund" ? (
          <Field
            label={t("payments.record.amount", { currency: receipt.currency })}
            value={amount}
            onChange={setAmount}
          />
        ) : null}
        <EvidenceFields
          reason={reason}
          evidence={evidence}
          onReason={setReason}
          onEvidence={setEvidence}
        />
        {preview ? (
          <div role="status" className="grid gap-2">
            <CustomerCreditPreview
              classification={preview.customerCreditBefore}
              label={t("payments.receipts.classificationBefore")}
            />
            <CustomerCreditPreview
              classification={preview.customerCreditAfter}
              label={t("payments.receipts.classificationAfter")}
            />
            <p>
              {t("payments.receipts.balancePreview", {
                number: receipt.reference,
                before: preview.availableBefore,
                after: preview.availableAfter,
                currency: receipt.currency,
              })}
            </p>
            {preview.invoice ? (
              <p>
                {t("payments.receipts.balancePreview", {
                  number: preview.invoice.id,
                  before: preview.invoice.before,
                  after: preview.invoice.after,
                  currency: preview.invoice.currency,
                })}
              </p>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={busy}>
          {preview ? t("payments.receipts.confirm") : t("payments.receipts.preview")}
        </Button>
      </form>
    </ReceiptDialog>
  )
}
