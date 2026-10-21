import { getRequestHeader, setResponseHeader } from "@tanstack/react-start/server"
import { localeFromAcceptLanguage } from "../i18n/accept-language"

/**
 * The language of the answer to a link that opens no document.
 *
 * A link signed for a document that it no longer opens (revoked, or the document withdrawn) answers
 * in that document's language, passed as `documentLocale`. With no document to take a language
 * from, the page answers in the visitor's, so the answer differs by `Accept-Language` and says so.
 * Nitro merges its own `Vary: Accept-Encoding` over the one set here whenever the client accepts
 * compression, so the answer is also kept out of every cache: a shared cache can then never hand
 * one visitor's language to another whatever `Vary` says.
 */
export function invalidLinkLocale(documentLocale?: string | null) {
  setResponseHeader("Cache-Control", "private, no-store")
  if (documentLocale) return documentLocale
  setResponseHeader("Vary", "Accept-Language")
  return localeFromAcceptLanguage(getRequestHeader("accept-language"))
}
