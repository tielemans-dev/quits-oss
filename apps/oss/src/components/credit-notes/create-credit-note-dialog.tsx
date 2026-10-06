import { useEffect, useMemo, useState } from "react"
import type { CreditNoteIssueInput } from "@yaip/contracts/credit-notes"
import { trpc } from "../../trpc/client"
import { buildCreditLines, type CreditBuildErrorCode } from "../../lib/credit-notes/calculation"
import { formatCurrency } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import type { TranslationKey } from "../../lib/i18n/messages"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table"
import { Textarea } from "../ui/textarea"
import type { CreditNoteAvailability } from "./types"

type Mode = CreditNoteIssueInput["mode"]

const modes: Array<{ value: Mode; label: TranslationKey }> = [
  { value: "full", label: "creditNotes.dialog.mode.full" },
  { value: "lines", label: "creditNotes.dialog.mode.lines" },
  { value: "amount", label: "creditNotes.dialog.mode.amount" },
]

const buildErrorKeys: Record<CreditBuildErrorCode, TranslationKey> = {
  fully_credited: "creditNotes.error.fully_credited",
  unknown_invoice_line: "creditNotes.error.generic",
  duplicate_invoice_line: "creditNotes.error.generic",
  quantity_exceeds_remaining: "creditNotes.error.quantity_exceeds_remaining",
  exceeds_invoice_total: "creditNotes.error.exceeds_invoice_total",
  nothing_to_credit: "creditNotes.error.nothing_to_credit",
}

function parseNumber(value: string) {
  const parsed = Number.parseFloat(value.replace(",", "."))
  return Number.isFinite(parsed) ? parsed : 0
}

export function CreateCreditNoteDialog({
  invoiceId,
  open,
  onOpenChange,
  onIssued,
}: {
  invoiceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onIssued: (creditNote: { id: string; number: string }) => void | Promise<void>
}) {
  const { t, locale } = useI18n()
  const [data, setData] = useState<CreditNoteAvailability | null>(null)
  const [mode, setMode] = useState<Mode>("full")
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [amount, setAmount] = useState("")
  const [reason, setReason] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setMode("full")
    setQuantities({})
    setAmount("")
    setReason("")
    setError(null)
    setData(null)
    trpc.creditNotes.availability
      .query({ invoiceId })
      .then(setData)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : t("creditNotes.error.generic"))
      )
  }, [open, invoiceId, t])

  const selection = useMemo((): CreditNoteIssueInput | null => {
    if (!data) return null
    const base = { invoiceId, reason: reason.trim() }
    if (mode === "full") return { ...base, mode }
    if (mode === "amount") return { ...base, mode, amount: Math.round(parseNumber(amount) * 100) / 100 }
    const lines = Object.entries(quantities)
      .map(([invoiceItemId, value]) => ({
        invoiceItemId,
        quantity: Math.round(parseNumber(value) * 100) / 100,
      }))
      .filter((line) => line.quantity > 0)
    return { ...base, mode, lines }
  }, [data, invoiceId, mode, amount, quantities, reason])

  const preview = useMemo(() => {
    if (!data || !selection) return null
    if (selection.mode === "lines" && selection.lines.length === 0) return null
    if (selection.mode === "amount" && selection.amount <= 0) return null
    return buildCreditLines({
      availability: data.availability,
      selection,
      taxRate: data.taxRate,
      amountDescription: "",
    })
  }, [data, selection])

  const money = (value: number) => formatCurrency(value, data?.currency, locale)
  const canSubmit = Boolean(selection && preview?.ok && reason.trim().length > 0 && !submitting)

  async function handleSubmit() {
    if (!selection || !canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const created = await trpc.creditNotes.issue.mutate(selection)
      onOpenChange(false)
      await onIssued(created)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("creditNotes.error.generic"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("creditNotes.dialog.title", { number: data?.invoiceNumber ?? "" })}
          </DialogTitle>
          {data && (
            <DialogDescription>
              {t("creditNotes.dialog.description", {
                remaining: money(data.availability.remainingGross),
              })}
            </DialogDescription>
          )}
        </DialogHeader>

        {!data && !error && <p className="text-sm text-muted-foreground">{t("creditNotes.loading")}</p>}

        {data && (
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label>{t("creditNotes.dialog.mode.label")}</Label>
              <div role="radiogroup" className="flex flex-wrap gap-2">
                {modes.map((option) => (
                  <Button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={mode === option.value}
                    variant={mode === option.value ? "default" : "outline"}
                    size="sm"
                    onClick={() => setMode(option.value)}
                  >
                    {t(option.label)}
                  </Button>
                ))}
              </div>
            </div>

            {mode === "lines" && (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("pdf.description")}</TableHead>
                      <TableHead className="text-right w-[90px]">
                        {t("creditNotes.dialog.lines.remaining")}
                      </TableHead>
                      <TableHead className="text-right w-[110px]">{t("pdf.unitPrice")}</TableHead>
                      <TableHead className="text-right w-[120px]">
                        {t("creditNotes.dialog.lines.credit")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.availability.lines.map((entry) => {
                      const exhausted = entry.remainingQuantity <= 0
                      return (
                        <TableRow key={entry.line.id} className={cn(exhausted && "opacity-50")}>
                          <TableCell>{entry.line.description}</TableCell>
                          <TableCell className="text-right">
                            {entry.remainingQuantity} / {entry.line.quantity}
                          </TableCell>
                          <TableCell className="text-right">{money(entry.line.unitPriceGross)}</TableCell>
                          <TableCell className="text-right">
                            <Input
                              type="number"
                              inputMode="decimal"
                              min={0}
                              max={entry.remainingQuantity}
                              step="0.01"
                              disabled={exhausted}
                              aria-label={`${t("creditNotes.dialog.lines.credit")}: ${entry.line.description}`}
                              className="h-8 text-right"
                              value={quantities[entry.line.id] ?? ""}
                              placeholder="0"
                              onChange={(event) =>
                                setQuantities((previous) => ({
                                  ...previous,
                                  [entry.line.id]: event.target.value,
                                }))
                              }
                            />
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}

            {mode === "amount" && (
              <div className="grid gap-2 sm:max-w-xs">
                <Label htmlFor="credit-note-amount">{t("creditNotes.dialog.amount.label")}</Label>
                <Input
                  id="credit-note-amount"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={data.availability.remainingGross}
                  step="0.01"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="credit-note-reason">{t("creditNotes.dialog.reason.label")}</Label>
              <Textarea
                id="credit-note-reason"
                maxLength={500}
                rows={3}
                placeholder={t("creditNotes.dialog.reason.placeholder")}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>

            <div className="flex items-center justify-between rounded-md bg-muted px-4 py-3 text-sm">
              <span className="text-muted-foreground">{t("creditNotes.dialog.preview")}</span>
              {preview?.ok ? (
                <span className="font-semibold">{money(preview.totalGross)}</span>
              ) : preview ? (
                <span className="text-destructive">{t(buildErrorKeys[preview.code])}</span>
              ) : (
                <span className="text-muted-foreground">{money(0)}</span>
              )}
            </div>
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("creditNotes.action.cancel")}
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {submitting ? t("creditNotes.action.issuing") : t("creditNotes.action.issue")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
