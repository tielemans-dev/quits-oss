import { useId } from "react"
import { useI18n } from "../lib/i18n/react"

/** Shared by company Settings and onboarding summaries. null leaves both choices unchecked. */
export function SellerVatStatus({ value, onChange, disabled = false }: {
  value: boolean | null
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const id = useId()
  return <fieldset disabled={disabled} className="grid gap-3">
    <legend className="mb-3 text-sm font-medium">{t("vatStatus.label")}</legend>
    <label className="flex items-start gap-3 text-sm">
      <input type="radio" name={id} value="registered" checked={value === true} onChange={() => onChange(true)} className="mt-0.5 size-4 accent-primary" />
      <span>{t("vatStatus.yes")}</span>
    </label>
    <div className="grid gap-1.5">
      <label className="flex items-start gap-3 text-sm">
        <input type="radio" name={id} value="not_registered" checked={value === false} onChange={() => onChange(false)} aria-describedby={`${id}-hint`} className="mt-0.5 size-4 accent-primary" />
        <span>{t("vatStatus.no")}</span>
      </label>
      <p id={`${id}-hint`} className="pl-7 text-sm text-muted-foreground">{t("vatStatus.noHint")}</p>
    </div>
  </fieldset>
}
