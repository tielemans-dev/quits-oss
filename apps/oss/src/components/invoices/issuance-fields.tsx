import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { LocalizedDateField } from "../localized-date-field"
import { useI18n } from "../../lib/i18n/react"
import type { FieldIssue } from "@quits/contracts/agent"
import { invoiceIssueKey } from "../../lib/invoice-field-issues"

export type IssuanceValues = { supplyDate: string; exchangeRate: string; rateDate: string }
export const initialIssuanceValues = (): IssuanceValues => ({ supplyDate: new Date().toISOString().slice(0, 10), exchangeRate: "", rateDate: new Date().toISOString().slice(0, 10) })
export function issuanceInput(value: IssuanceValues, currency: string, baseCurrency?: string) {
  return { supplyDate: value.supplyDate, ...(baseCurrency && currency !== baseCurrency ? { exchangeRate: value.exchangeRate, rateDate: value.rateDate } : {}) }
}
export function IssuanceFields({ value, onChange, currency, baseCurrency, showHint = true, errors = [] }: {
  value: IssuanceValues; onChange: (value: IssuanceValues) => void; currency: string; baseCurrency?: string;
  showHint?: boolean; errors?: FieldIssue[];
}) {
  const { t, locale } = useI18n()
  return <div className="grid gap-3">
    <div className="grid gap-2"><Label htmlFor="supplyDate">{t("invoices.issuance.supplyDate")}</Label><LocalizedDateField id="supplyDate" required value={value.supplyDate} locale={locale} placeholder={t("docForm.selectDate")} clearLabel={t("docForm.clear")} onChange={supplyDate => onChange({ ...value, supplyDate })} /></div>
    {errors.filter(issue => ["supplyDate", "exchangeRate", "rateDate"].includes(issue.field)).map(issue => <p key={issue.field} role="alert" className="text-sm text-destructive">{t(invoiceIssueKey(issue.code), issue.params)}</p>)}
    {showHint && <p className="text-sm text-muted-foreground">{t("invoices.issuance.confirmDates")}</p>}
    {baseCurrency && currency !== baseCurrency && <>
      <div className="grid gap-2"><Label htmlFor="exchangeRate">{t("invoices.issuance.rate", { currency, baseCurrency })}</Label><Input id="exchangeRate" inputMode="decimal" required value={value.exchangeRate} onChange={event => onChange({ ...value, exchangeRate: event.target.value })} /></div>
      <div className="grid gap-2"><Label htmlFor="rateDate">{t("invoices.issuance.rateDate")}</Label><Input id="rateDate" type="date" required value={value.rateDate} onChange={event => onChange({ ...value, rateDate: event.target.value })} /></div>
    </>}
  </div>
}
