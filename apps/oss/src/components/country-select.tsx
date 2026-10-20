import { countryName, ISO_COUNTRY_CODES } from "../lib/country-names"
import { useI18n } from "../lib/i18n/react"
import { ownFirstThenAlphabetical } from "../lib/picker-options"
import { useState } from "react"

/** Keep an unknown stored value visible until the user explicitly replaces it. */
export function CountrySelect({ value, defaultCountry, ...props }: { value?: string | null; defaultCountry?: string | null; id: string; name: string }) {
  const { locale } = useI18n()
  const [selected, setSelected] = useState<string | null>(null)
  const fallback = defaultCountry && ISO_COUNTRY_CODES.includes(defaultCountry) ? defaultCountry : ""
  const current = selected ?? (value === undefined ? fallback : value?.trim() || "")
  // The organization's own country first: most customers share it.
  const options = ownFirstThenAlphabetical(ISO_COUNTRY_CODES.map(code => ({ value: code, label: countryName(code, locale) })), fallback, locale)
  return <select {...props} value={current} onChange={event => setSelected(event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
    <option value="" />
    {current && !ISO_COUNTRY_CODES.includes(current) && <option value={current}>{current}</option>}
    {options.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
  </select>
}
