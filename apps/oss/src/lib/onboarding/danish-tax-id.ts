const DANISH_PAIR_SCHEMES = new Set(["cvr", "vat", "dk_cvr", "dk_vat"])

/**
 * Confirmation replaces the Danish CVR/VAT pair. A countryless value is foreign only when it
 * carries another country's prefix and a digit, so placeholders such as "old" are still replaced.
 */
export function isReplacedDanishTaxId(id: { scheme: string; value: string; countryCode: string | null }): boolean {
  const scheme = id.scheme.trim().toLowerCase()
  if (!DANISH_PAIR_SCHEMES.has(scheme)) return false
  if (id.countryCode?.trim()) return id.countryCode.trim().toUpperCase() === "DK"
  return !isCountrylessForeignVat(id.value)
}

function isCountrylessForeignVat(value: string): boolean {
  const compact = value.replace(/[\s.\-/]/g, "").toUpperCase()
  const match = compact.match(/^([A-Z]{2})([A-Z0-9]+)$/)
  if (!match) return false
  const [, prefix, rest] = match
  return prefix !== "DK" && /\d/.test(rest)
}
