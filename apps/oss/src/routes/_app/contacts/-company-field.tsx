import { useState } from "react"
import { Input } from "../../../components/ui/input"
import { Label } from "../../../components/ui/label"
import { useI18n } from "../../../lib/i18n/react"

/**
 * The customer's business name. Where an issuance policy accepts business customers only, the hint
 * says so while the field is empty; once a business name is filled in it has nothing left to say.
 */
export function CompanyField({ businessOnly, defaultValue, placeholder }: { businessOnly: boolean; defaultValue?: string; placeholder?: string }) {
  const { t } = useI18n()
  const [filled, setFilled] = useState(Boolean(defaultValue?.trim()))
  const hint = businessOnly && !filled
  return (
    <div className="grid gap-2">
      <Label htmlFor="company">{t("contacts.field.company")}</Label>
      <Input
        id="company"
        aria-describedby={hint ? "company-help" : undefined}
        name="company"
        maxLength={120}
        defaultValue={defaultValue}
        placeholder={placeholder}
        onChange={(event) => setFilled(Boolean(event.target.value.trim()))}
      />
      {hint && <p id="company-help" className="text-sm text-muted-foreground">{t("contacts.businessOnly.help")}</p>}
    </div>
  )
}
