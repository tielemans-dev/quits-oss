import { nonVatStatement } from "./non-vat-note"

/** Remove generated presets for explicit status; preserve unknown historic EU-VAT notes. */
export function withoutNonVatStatement(note: string | null | undefined, momsRegistered: boolean | null | undefined, taxRegime?: string | null) {
  if (!note || (momsRegistered == null && (taxRegime == null || taxRegime === "eu_vat"))) return note
  let text = note
  for (const locale of ["da", "en"]) text = text.split(nonVatStatement(locale)).join("")
  return text === note ? note : text.trim() || null
}
