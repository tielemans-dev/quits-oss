import { useI18n } from "../../lib/i18n/react"
import { Input } from "../ui/input"

/** The document-wide VAT percentage, for organizations whose rate no adopter policy fixes. */
export function TaxRateInput({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const { t } = useI18n()
  return <div className="flex items-center gap-1">
    <Input type="number" min="0" max="100" step="0.01" aria-label={t("docForm.summary.tax")} disabled={disabled} value={value || ""}
      onChange={event => onChange(event.target.value)} className="w-16 h-7 text-xs" />
    <span className="text-muted-foreground text-xs">%</span>
  </div>
}
