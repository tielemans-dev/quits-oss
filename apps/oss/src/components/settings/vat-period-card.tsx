import { useI18n } from "../../lib/i18n/react"
import { VAT_PERIODS, type VatPeriod } from "../../lib/vat-deadline"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card"
import { Label } from "../ui/label"

/**
 * The moms period decides which deadline Overblik counts down to. It saves on its own through
 * `onChange`, and "Not set" takes the countdown away again.
 */
export function VatPeriodCard({
  value,
  busy = false,
  onChange,
}: {
  value: VatPeriod | null
  busy?: boolean
  onChange: (period: VatPeriod | null) => void
}) {
  const { t } = useI18n()
  const options = [null, ...VAT_PERIODS] as const
  return (
    <Card data-testid="vat-period-card">
      <CardHeader>
        <CardTitle>{t("settings.vatPeriod.title")}</CardTitle>
        <CardDescription>{t("settings.vatPeriod.help")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div role="radiogroup" aria-label={t("settings.vatPeriod.title")} className="grid gap-2">
          {options.map((option) => (
            <div key={option ?? "none"} className="flex items-center gap-3">
              <input
                id={`vatPeriod-${option ?? "none"}`}
                type="radio"
                name="vatPeriod"
                checked={value === option}
                disabled={busy}
                onChange={() => onChange(option)}
                className="accent-foreground size-4"
              />
              <Label htmlFor={`vatPeriod-${option ?? "none"}`}>{t(`settings.vatPeriod.option.${option ?? "none"}`)}</Label>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
