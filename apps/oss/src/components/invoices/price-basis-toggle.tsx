import { useI18n } from "../../lib/i18n/react"
import { Button } from "../ui/button"

export function PriceBasisToggle({ value, onChange, disabled }: {
  value: boolean; onChange: (value: boolean) => void; disabled?: boolean;
}) {
  const { t } = useI18n()
  return <div className="grid gap-2">
    <span className="text-sm font-medium">{t("invoiceVat.priceBasis")}</span>
    <div role="radiogroup" aria-label={t("invoiceVat.priceBasis")} className="flex w-fit rounded-md border p-1">
      {[false, true].map(inclusive => <Button key={String(inclusive)} type="button" role="radio"
        aria-checked={value === inclusive} tabIndex={value === inclusive ? 0 : -1} disabled={disabled} size="sm" variant={value === inclusive ? "secondary" : "ghost"}
        onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
          event.preventDefault()
          const next = event.key === "Home" ? false : event.key === "End" ? true : !inclusive
          onChange(next)
          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[Number(next)]?.focus()
        }}
        onClick={() => onChange(inclusive)}>{t(inclusive ? "invoiceVat.pricesInclude" : "invoiceVat.pricesExclude")}</Button>)}
    </div>
  </div>
}
