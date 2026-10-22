import { useState } from "react"
import { Input } from "../../../components/ui/input"
import { Label } from "../../../components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select"
import { useI18n } from "../../../lib/i18n/react"

/**
 * The customer's business name. Where an issuance policy accepts business customers only, the hint
 * says so while the field is empty; once a business name is filled in it has nothing left to say.
 * A `locked` name comes from the CVR register, as does the CVR number that points to its hint. With
 * `names`, the legal name and its registered secondary names (binavne), it is chosen from that list.
 */
export function CompanyField({ businessOnly, defaultValue, placeholder, locked = false, names = [] }: { businessOnly: boolean; defaultValue?: string; placeholder?: string; locked?: boolean; names?: readonly string[] }) {
  const { t } = useI18n()
  const [filled, setFilled] = useState(Boolean(defaultValue?.trim()))
  const hint = businessOnly && !filled && !locked
  return (
    <div className="grid gap-2">
      <Label htmlFor="company">{t("contacts.field.company")}</Label>
      {locked && names.length > 1 ? (
        <Select name="company" defaultValue={defaultValue}>
          <SelectTrigger id="company" aria-describedby="registry-help" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{names.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent>
        </Select>
      ) : <Input
        id="company"
        aria-describedby={hint ? "company-help" : locked ? "registry-help" : undefined}
        readOnly={locked}
        name="company"
        maxLength={120}
        defaultValue={defaultValue}
        placeholder={placeholder}
        onChange={(event) => setFilled(Boolean(event.target.value.trim()))}
      />}
      {hint && <p id="company-help" className="text-sm text-muted-foreground">{t("contacts.businessOnly.help")}</p>}
      {locked && <p id="registry-help" className="text-sm text-muted-foreground">{t(names.length > 1 ? "contacts.registry.lockedNames" : "contacts.registry.locked")}</p>}
    </div>
  )
}
