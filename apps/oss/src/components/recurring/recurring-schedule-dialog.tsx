import { useEffect, useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import type { RecurringEnd } from "@yaip/contracts/recurring"
import { trpc } from "../../trpc/client"
import { formatCurrency } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { useOrgCurrency } from "../../hooks/use-org-currency"
import { LocalizedDateField } from "../localized-date-field"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { Textarea } from "../ui/textarea"
import {
  toCalendarDate,
  type RecurringIntervalUnit,
  type RecurringScheduleListItem,
} from "./recurring-format"

type Contact = { id: string; name: string }
type LineItem = { description: string; quantity: number; unitPrice: number }
type EndType = RecurringEnd["type"]

/** The fields of a schedule the dialog can edit. */
export type EditableSchedule = Pick<
  RecurringScheduleListItem,
  | "id"
  | "name"
  | "contactId"
  | "items"
  | "taxRate"
  | "currency"
  | "notes"
  | "intervalCount"
  | "intervalUnit"
  | "startDate"
  | "dueInDays"
  | "autoSend"
  | "endsAt"
  | "remainingRuns"
>

const emptyItem = (): LineItem => ({ description: "", quantity: 1, unitPrice: 0 })

function initialEndType(schedule?: EditableSchedule): EndType {
  if (schedule?.endsAt) return "on_date"
  if (schedule?.remainingRuns !== null && schedule?.remainingRuns !== undefined) return "after_runs"
  return "none"
}

export function RecurringScheduleDialog({
  open,
  onOpenChange,
  schedule,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Omit to create a new schedule. */
  schedule?: EditableSchedule
  onSaved: () => void
}) {
  const { t, locale } = useI18n()
  const orgCurrency = useOrgCurrency()
  const currency = schedule?.currency ?? orgCurrency

  const [contacts, setContacts] = useState<Contact[]>([])
  const [loadingContacts, setLoadingContacts] = useState(true)
  const [name, setName] = useState("")
  const [contactId, setContactId] = useState("")
  const [items, setItems] = useState<LineItem[]>([emptyItem()])
  const [taxRate, setTaxRate] = useState(0)
  const [notes, setNotes] = useState("")
  const [intervalCount, setIntervalCount] = useState(1)
  const [intervalUnit, setIntervalUnit] = useState<RecurringIntervalUnit>("month")
  const [startDate, setStartDate] = useState("")
  const [dueInDays, setDueInDays] = useState(14)
  const [autoSend, setAutoSend] = useState(false)
  const [endType, setEndType] = useState<EndType>("none")
  const [endsAt, setEndsAt] = useState("")
  const [runs, setRuns] = useState(12)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setName(schedule?.name ?? "")
    setContactId(schedule?.contactId ?? "")
    setItems(schedule?.items.length ? schedule.items.map((item) => ({ ...item })) : [emptyItem()])
    setTaxRate(schedule?.taxRate ?? 0)
    setNotes(schedule?.notes ?? "")
    setIntervalCount(schedule?.intervalCount ?? 1)
    setIntervalUnit(schedule?.intervalUnit ?? "month")
    setStartDate(schedule ? toCalendarDate(schedule.startDate) : toCalendarDate(new Date()))
    setDueInDays(schedule?.dueInDays ?? 14)
    setAutoSend(schedule?.autoSend ?? false)
    setEndType(initialEndType(schedule))
    setEndsAt(schedule?.endsAt ? toCalendarDate(schedule.endsAt) : "")
    setRuns(schedule?.remainingRuns ?? 12)

    setLoadingContacts(true)
    trpc.contacts.list
      .query()
      .then((data) => setContacts(data as Contact[]))
      .catch(() => {})
      .finally(() => setLoadingContacts(false))
  }, [open, schedule])

  function updateItem(index: number, patch: Partial<LineItem>) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  }

  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
  const taxAmount = (subtotal * taxRate) / 100

  function buildEnd(): RecurringEnd {
    if (endType === "on_date") return { type: "on_date", endsAt }
    if (endType === "after_runs") return { type: "after_runs", runs }
    return { type: "none" }
  }

  async function handleSubmit() {
    setError(null)
    if (!name.trim()) return setError(t("recurring.form.validation.name"))
    if (!contactId) return setError(t("docForm.validation.contactRequired"))
    if (items.some((item) => !item.description.trim())) {
      return setError(t("docForm.validation.itemDescriptionRequired"))
    }
    if (!startDate) return setError(t("recurring.form.validation.startDate"))
    if (endType === "on_date" && !endsAt) return setError(t("recurring.form.validation.endsAt"))

    const fields = {
      name: name.trim(),
      contactId,
      items,
      taxRate,
      intervalCount,
      intervalUnit,
      startDate,
      dueInDays,
      autoSend,
      end: buildEnd(),
    }

    setSaving(true)
    try {
      if (schedule) {
        await trpc.recurring.update.mutate({ id: schedule.id, ...fields, notes: notes.trim() || null })
      } else {
        await trpc.recurring.create.mutate({ ...fields, notes: notes.trim() || undefined })
      }
      onOpenChange(false)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : t("recurring.form.error"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {schedule ? t("recurring.form.editTitle") : t("recurring.form.createTitle")}
          </DialogTitle>
          <DialogDescription>{t("recurring.form.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-5">
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="recurring-name">{t("recurring.form.name")} *</Label>
              <Input
                id="recurring-name"
                value={name}
                placeholder={t("recurring.form.namePlaceholder")}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("docForm.contact")} *</Label>
              {loadingContacts ? (
                <p className="text-sm text-muted-foreground py-2">{t("docForm.loadingContacts")}</p>
              ) : contacts.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">{t("docForm.noContacts")}</p>
              ) : (
                <Select value={contactId} onValueChange={setContactId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t("docForm.selectContact")} />
                  </SelectTrigger>
                  <SelectContent>
                    {contacts.map((contact) => (
                      <SelectItem key={contact.id} value={contact.id}>
                        {contact.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          <div className="grid gap-3">
            <Label>{t("docForm.lineItems")}</Label>
            <div className="rounded-md border">
              <div className="grid grid-cols-[1fr_80px_110px_110px_40px] gap-2 p-3 border-b bg-muted/50 text-sm font-medium">
                <span>{t("docForm.column.description")}</span>
                <span>{t("docForm.column.qty")}</span>
                <span>{t("docForm.column.unitPrice")}</span>
                <span className="text-right pr-2">{t("docForm.column.total")}</span>
                <span />
              </div>
              {items.map((item, index) => (
                <div
                  key={index}
                  className="grid grid-cols-[1fr_80px_110px_110px_40px] gap-2 p-3 border-b last:border-0 items-center"
                >
                  <Input
                    placeholder={t("docForm.column.description")}
                    value={item.description}
                    onChange={(event) => updateItem(index, { description: event.target.value })}
                  />
                  <Input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={item.quantity || ""}
                    onChange={(event) => updateItem(index, { quantity: parseFloat(event.target.value) || 0 })}
                  />
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={item.unitPrice || ""}
                    onChange={(event) => updateItem(index, { unitPrice: parseFloat(event.target.value) || 0 })}
                  />
                  <span className="text-sm text-right pr-2">
                    {formatCurrency(item.quantity * item.unitPrice, currency, locale)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))}
                    disabled={items.length <= 1}
                  >
                    <Trash2 className="size-4 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex items-start justify-between gap-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => setItems((prev) => [...prev, emptyItem()])}
              >
                <Plus className="size-4" />
                {t("docForm.action.addItem")}
              </Button>
              <div className="w-64 grid gap-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("docForm.summary.subtotal")}</span>
                  <span>{formatCurrency(subtotal, currency, locale)}</span>
                </div>
                <div className="flex justify-between items-center gap-2">
                  <span className="text-muted-foreground">{t("docForm.summary.tax")}</span>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={taxRate || ""}
                      onChange={(event) => setTaxRate(parseFloat(event.target.value) || 0)}
                      className="w-16 h-7 text-xs"
                    />
                    <span className="text-muted-foreground text-xs">%</span>
                    <span className="ml-auto">{formatCurrency(taxAmount, currency, locale)}</span>
                  </div>
                </div>
                <div className="flex justify-between font-semibold border-t pt-2">
                  <span>{t("docForm.summary.total")}</span>
                  <span>{formatCurrency(subtotal + taxAmount, currency, locale)}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="recurring-interval">{t("recurring.form.repeatEvery")}</Label>
              <div className="flex gap-2">
                <Input
                  id="recurring-interval"
                  type="number"
                  min="1"
                  max="12"
                  className="w-20"
                  value={intervalCount}
                  onChange={(event) =>
                    setIntervalCount(Math.min(12, Math.max(1, parseInt(event.target.value, 10) || 1)))
                  }
                />
                <Select
                  value={intervalUnit}
                  onValueChange={(value) => setIntervalUnit(value as RecurringIntervalUnit)}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="week">{t("recurring.unit.week")}</SelectItem>
                    <SelectItem value="month">{t("recurring.unit.month")}</SelectItem>
                    <SelectItem value="year">{t("recurring.unit.year")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="recurring-start">{t("recurring.form.startDate")} *</Label>
              <LocalizedDateField
                id="recurring-start"
                value={startDate}
                onChange={setStartDate}
                locale={locale}
                placeholder={t("docForm.selectDate")}
                clearLabel={t("docForm.clear")}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="recurring-due">{t("recurring.form.dueInDays")}</Label>
              <Input
                id="recurring-due"
                type="number"
                min="0"
                max="120"
                value={dueInDays}
                onChange={(event) =>
                  setDueInDays(Math.min(120, Math.max(0, parseInt(event.target.value, 10) || 0)))
                }
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>{t("recurring.form.delivery")}</Label>
              <Select value={autoSend ? "send" : "draft"} onValueChange={(value) => setAutoSend(value === "send")}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">{t("recurring.form.delivery.draft")}</SelectItem>
                  <SelectItem value="send">{t("recurring.form.delivery.send")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>{t("recurring.form.end")}</Label>
              <Select value={endType} onValueChange={(value) => setEndType(value as EndType)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("recurring.form.end.none")}</SelectItem>
                  <SelectItem value="on_date">{t("recurring.form.end.onDate")}</SelectItem>
                  <SelectItem value="after_runs">{t("recurring.form.end.afterRuns")}</SelectItem>
                </SelectContent>
              </Select>
              {endType === "on_date" && (
                <LocalizedDateField
                  id="recurring-ends-at"
                  value={endsAt}
                  onChange={setEndsAt}
                  locale={locale}
                  placeholder={t("recurring.form.endsAt")}
                  clearLabel={t("docForm.clear")}
                />
              )}
              {endType === "after_runs" && (
                <div className="flex items-center gap-2">
                  <Input
                    id="recurring-runs"
                    type="number"
                    min="1"
                    max="1000"
                    className="w-24"
                    aria-label={t("recurring.form.runs")}
                    value={runs}
                    onChange={(event) =>
                      setRuns(Math.min(1000, Math.max(1, parseInt(event.target.value, 10) || 1)))
                    }
                  />
                  <span className="text-sm text-muted-foreground">{t("recurring.form.runs")}</span>
                </div>
              )}
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="recurring-notes">{t("docForm.notes")}</Label>
            <Textarea
              id="recurring-notes"
              rows={2}
              value={notes}
              placeholder={t("recurring.form.notesPlaceholder")}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("docForm.action.cancel")}
          </Button>
          <Button type="button" disabled={saving} onClick={handleSubmit}>
            {saving
              ? t("docForm.action.saving")
              : schedule
                ? t("recurring.form.save")
                : t("recurring.form.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
