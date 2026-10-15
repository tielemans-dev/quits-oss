import { useState } from "react"
import { defaultMappings, mappingsSchema, missingSalesMappings, type AccountingMappings } from "../../domain/accounting/mappings"
import { useI18n } from "../../lib/i18n/react"
import { Button } from "../ui/button"
import { Input } from "../ui/input"

export function AccountingMappingsEditor({ provider, config, canEdit, busy, save }: {
  provider: string; config: AccountingMappings; canEdit: boolean; busy: boolean
  save: (mappings: AccountingMappings) => Promise<boolean>
}) {
  const { t } = useI18n(), [draft, setDraft] = useState(config), [invalid, setInvalid] = useState(false), [saved, setSaved] = useState(false)
  const missing = missingSalesMappings(config, provider)
  const update = (index: number, patch: Partial<AccountingMappings["rows"][number]>) => {
    setSaved(false)
    setDraft(value => ({ ...value, rows: value.rows.map((row, at) => at === index ? { ...row, ...patch } : row) }))
  }
  return <section className="grid gap-3 border-t pt-3" aria-label={t("accounting.mappings.title")}>
    <h4 className="text-sm font-medium">{t("accounting.mappings.title")}</h4>
    <p className="text-sm text-muted-foreground">{t("accounting.mappings.help")}</p>
    {provider === "economic" ? <p className="text-sm text-muted-foreground">{t("accounting.mappings.economicHelp")}</p> : null}
    {missing.length || !config.rows.length ? <p className="text-sm text-destructive">{t("accounting.mappings.salesBlocked", { groups: missing.map(row => `${t(`accounting.mappings.${row.kind}`)} ${row.country}`).join(", ") || t("accounting.mappings.empty") })}</p> : null}
    {!config.paymentAccount ? <p className="text-sm text-destructive">{t("accounting.mappings.paymentBlocked")}</p> : null}
    <form className="grid gap-3" onSubmit={async event => {
      event.preventDefault()
      const parsed = mappingsSchema.safeParse(draft)
      setInvalid(!parsed.success)
      if (parsed.success) setSaved(await save(parsed.data))
    }}>
      <fieldset disabled={busy || !canEdit} className="grid min-w-0 gap-3">
        {draft.rows.map((row, index) => <div key={index} className="grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">{t("accounting.mappings.group")}
            <select className="h-9 rounded-md border bg-background px-3" value={row.kind} onChange={event => update(index, { kind: event.target.value as typeof row.kind })}>
              {(["domestic", "services", "goods"] as const).map(kind => <option key={kind} value={kind}>{t(`accounting.mappings.${kind}`)}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">{t("accounting.mappings.country")}<Input maxLength={2} value={row.country} onChange={event => update(index, { country: event.target.value.toUpperCase() })} /></label>
          {(["revenueAccount", "vatCode", ...(provider === "economic" ? ["productNumber", "vatZoneNumber"] as const : [])] as const).map(field => {
            const numeric = field === "revenueAccount" || field === "vatZoneNumber"
            return <label key={field} className="grid gap-1 text-sm">{t(`accounting.mappings.${field}`)}
              <Input type={numeric ? "number" : "text"} min={numeric ? 1 : undefined} max={numeric ? 2147483647 : undefined} step={numeric ? 1 : undefined} maxLength={25} value={row[field] ?? ""} onChange={event => update(index, { [field]: numeric ? event.target.value === "" ? null : Number(event.target.value) : event.target.value })} />
            </label>
          })}
          {canEdit ? <Button type="button" variant="ghost" size="sm" onClick={() => { setSaved(false); setDraft(value => ({ ...value, rows: value.rows.filter((_, at) => at !== index) })) }}>{t("accounting.mappings.remove")}</Button> : null}
        </div>)}
        <label className="grid gap-1 text-sm">{t("accounting.mappings.paymentAccount")}<Input type="number" min={1} max={2147483647} step={1} value={draft.paymentAccount ?? ""} onChange={event => { setSaved(false); setDraft({ ...draft, paymentAccount: event.target.value === "" ? null : Number(event.target.value) }) }} /></label>
        {canEdit ? <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={draft.rows.length >= 100} onClick={() => { setSaved(false); setDraft({ ...draft, rows: [...draft.rows, { ...defaultMappings().rows[0]!, kind: "services", country: "" }] }) }}>{t("accounting.mappings.add")}</Button>
          <Button type="submit" size="sm">{t("accounting.mappings.save")}</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => { setDraft(config); setInvalid(false); setSaved(false) }}>{t("accounting.disconnect.cancel")}</Button>
        </div> : null}
      </fieldset>
      {invalid ? <p role="alert" className="text-sm text-destructive">{t("accounting.mappings.invalid")}</p> : null}
      {saved ? <p role="status" className="text-sm">{t("accounting.mappings.saved")}</p> : null}
    </form>
  </section>
}
