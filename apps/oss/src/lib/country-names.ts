import { ISO_COUNTRY_CODES as CANONICAL_COUNTRY_CODES } from "./compliance/iso-countries"
import { toCountryCode } from "./exports/parties"

/** The canonical country set (ISO 3166-1 plus Kosovo). Display labels are supplied by the current locale. */
export const ISO_COUNTRY_CODES: readonly string[] = [...CANONICAL_COUNTRY_CODES]

export function countryName(value: string | null | undefined, locale: string | null | undefined = "en-US"): string {
  if (!value) return ""
  // Issued-document snapshots keep whatever the contact held when they were issued: a code or a name in any common language.
  const code = toCountryCode(value)
  if (!code || !CANONICAL_COUNTRY_CODES.has(code)) return value
  return new Intl.DisplayNames([locale || "en-US"], { type: "region" }).of(code) ?? code
}
