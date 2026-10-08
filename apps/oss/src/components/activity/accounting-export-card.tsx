import type { AccountingDataset } from "@quits/contracts/exports"
import { Download } from "lucide-react"
import { useState } from "react"
import { downloadTextFile } from "../../lib/exports/download"
import { useI18n } from "../../lib/i18n/react"
import { trpc } from "../../trpc/client"
import { LocalizedDateField } from "../localized-date-field"
import { Button } from "../ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../ui/card"
import { Label } from "../ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"

const DATASETS: AccountingDataset[] = ["invoices", "creditNotes", "payments", "settlements"]

function isoDate(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

/** The previous calendar month, the usual period handed to an accountant. */
function previousMonth() {
  const now = new Date()
  return {
    from: isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
    to: isoDate(new Date(now.getFullYear(), now.getMonth(), 0)),
  }
}

function errorCode(error: unknown) {
  return (error as { data?: { code?: string } } | null)?.data?.code
}

/** Date-range CSV export of invoices, credit notes, or payments. */
export function AccountingExportCard() {
  const { t, locale } = useI18n()
  const [range, setRange] = useState(previousMonth)
  const [dataset, setDataset] = useState<AccountingDataset>("invoices")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const invalidRange = Boolean(range.from && range.to && range.from > range.to)

  async function handleDownload() {
    if (!range.from || !range.to || invalidRange) return
    setBusy(true)
    setError(null)
    try {
      const result = await trpc.exports.accounting.query({ ...range, dataset })
      downloadTextFile(result.filename, result.csv, "text/csv;charset=utf-8")
    } catch (err) {
      setError(
        errorCode(err) === "FORBIDDEN" ? t("exports.accounting.forbidden") : t("exports.accounting.error")
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("exports.accounting.title")}</CardTitle>
        <CardDescription>{t("exports.accounting.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="grid gap-2">
            <Label htmlFor="accounting-from">{t("exports.accounting.from")}</Label>
            <LocalizedDateField
              id="accounting-from"
              value={range.from}
              onChange={(from) => setRange((current) => ({ ...current, from }))}
              locale={locale}
              placeholder={t("exports.accounting.from")}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="accounting-to">{t("exports.accounting.to")}</Label>
            <LocalizedDateField
              id="accounting-to"
              value={range.to}
              onChange={(to) => setRange((current) => ({ ...current, to }))}
              locale={locale}
              placeholder={t("exports.accounting.to")}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="accounting-dataset">{t("exports.accounting.dataset")}</Label>
            <Select value={dataset} onValueChange={(value) => setDataset(value as AccountingDataset)}>
              <SelectTrigger id="accounting-dataset">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DATASETS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {t(`exports.accounting.dataset.${option}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {invalidRange ? (
          <p className="text-sm text-destructive" role="alert">
            {t("exports.accounting.invalidRange")}
          </p>
        ) : null}
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="flex justify-end">
        <Button
          type="button"
          onClick={handleDownload}
          disabled={busy || invalidRange || !range.from || !range.to}
        >
          <Download className="size-4" />
          {busy ? t("exports.accounting.preparing") : t("exports.accounting.download")}
        </Button>
      </CardFooter>
    </Card>
  )
}
