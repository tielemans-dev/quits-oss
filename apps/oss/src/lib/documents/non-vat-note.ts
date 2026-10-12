import { translate } from "../i18n/translate"

/** The registration statement follows the document language, not the organization's language. */
export function nonVatStatement(locale?: string | null) {
  return translate("pdf.nonVatRegistered", locale)
}

export function withNonVatStatement(note: string | null, momsRegistered: boolean | null | undefined, locale?: string | null) {
  if (momsRegistered !== false) return note
  const statement = nonVatStatement(locale)
  return note?.includes(statement) ? note : [note, statement].filter(Boolean).join("\n")
}

/** Translate only the generated preset. A seller's custom payment instructions stay verbatim. */
export function localizedNonVatPaymentNote(note: string | null | undefined, momsRegistered: boolean | null | undefined, locale?: string | null) {
  return momsRegistered === false && [nonVatStatement("da"), nonVatStatement("en")].includes(note ?? "")
    ? nonVatStatement(locale) : note
}
