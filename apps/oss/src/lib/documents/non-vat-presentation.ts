import { nonVatStatement } from "./non-vat-note"

/** Render the generated statement in one dedicated place without changing stored notes. */
export function withoutNonVatStatement(note: string | null | undefined, momsRegistered: boolean | null | undefined) {
  if (momsRegistered !== false || !note) return note
  let text = note
  for (const locale of ["da", "en"]) text = text.split(nonVatStatement(locale)).join("")
  return text === note ? note : text.trim() || null
}
