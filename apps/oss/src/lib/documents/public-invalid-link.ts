import { getRequestHeader, setResponseHeader } from "@tanstack/react-start/server"
import { localeFromAcceptLanguage } from "../i18n/accept-language"

/**
 * The language of the answer to a link that opens no document.
 *
 * With no document to take a language from, the page answers in the visitor's, so the answer
 * differs by `Accept-Language` and says so. Nitro merges its own `Vary: Accept-Encoding` over the
 * one set here whenever the client accepts compression, so the answer is also kept out of every
 * cache: a shared cache can then never hand one visitor's language to another whatever `Vary` says.
 */
export function invalidLinkLocale() {
  setResponseHeader("Vary", "Accept-Language")
  setResponseHeader("Cache-Control", "private, no-store")
  return localeFromAcceptLanguage(getRequestHeader("accept-language"))
}
