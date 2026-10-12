import { translate } from "../i18n/translate"

/** The registration statement follows the document language, not the organization's language. */
export function nonVatStatement(locale?: string | null) {
  return translate("invoice.noVatNote", locale)
}

export function withNonVatStatement(note: string | null, momsRegistered: boolean | null | undefined, locale?: string | null) {
  if (momsRegistered !== false) return note
  const statement = nonVatStatement(locale)
  return note?.includes(statement) ? note : [note, statement].filter(Boolean).join("\n")
}

/** Normalize only known generated lines when creating a new frozen payment snapshot. */
export function localizedNonVatPaymentNote(note: string | null | undefined, momsRegistered: boolean | null | undefined, locale?: string | null) {
  if (momsRegistered == null) return note
  const generated = [nonVatStatement("da"), nonVatStatement("en"), "Virksomheden er ikke momsregistreret.", "The company is not VAT registered."]
  const custom = note?.split("\n").filter(line => !generated.includes(line)).join("\n") || null
  return momsRegistered ? custom : withNonVatStatement(custom, false, locale)
}
