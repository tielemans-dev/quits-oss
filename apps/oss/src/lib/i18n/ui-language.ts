import { createIsomorphicFn } from "@tanstack/react-start"
import { getRequestHeader } from "@tanstack/react-start/server"
import { localeFromAcceptLanguage } from "./accept-language"
import { resolveLanguage } from "./translate"
import type { SupportedLanguage } from "./messages"

/**
 * The interface language a person picked: `?lang=da|en` on any page, or the language switch in the
 * user menu. It is kept in a cookie rather than localStorage so the server renders the page in it.
 * It is the person's, not the organization's: documents keep the organization's locale.
 */
export const UI_LANGUAGE_COOKIE = "quits-lang"
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

const LANGUAGE_LOCALES: Record<SupportedLanguage, string> = { da: "da-DK", en: "en-US" }

export type UiLanguage = {
  /** `?lang` on this page, else the saved choice. */
  chosen?: SupportedLanguage
  /** The browser's preferred supported locale, English when it prefers neither. */
  browser: string
}

export function parseUiLanguage(value: unknown): SupportedLanguage | undefined {
  return value === "da" || value === "en" ? value : undefined
}

function savedLanguage(cookie: string | undefined): SupportedLanguage | undefined {
  for (const part of (cookie ?? "").split(";")) {
    const [name, value] = part.trim().split("=")
    if (name === UI_LANGUAGE_COOKIE) return parseUiLanguage(value)
  }
  return undefined
}

export function resolveUiLanguage(input: { search?: unknown; cookie?: string; acceptLanguage?: string }): UiLanguage {
  const requested = parseUiLanguage((input.search as { lang?: unknown } | undefined)?.lang)
  return {
    chosen: requested ?? savedLanguage(input.cookie),
    browser: localeFromAcceptLanguage(input.acceptLanguage),
  }
}

// The server reads the request; the browser reads its own cookie and languages, which say the same.
const readRequest = createIsomorphicFn()
  .server(() => ({ cookie: getRequestHeader("cookie"), acceptLanguage: getRequestHeader("accept-language") }))
  .client(() => ({ cookie: document.cookie, acceptLanguage: navigator.languages?.join(",") || navigator.language }))

export function readUiLanguage(search: unknown): UiLanguage {
  return resolveUiLanguage({ search, ...readRequest() })
}

/**
 * The locale the interface speaks. A chosen language wins over the organization's locale, which
 * wins over the browser's. When the organization's locale already speaks the chosen language it is
 * kept, so its regional formats stay. Without `organizationLocale` (login, signup, a new account)
 * this is the chosen language or the browser's.
 */
export function uiLocale(language: UiLanguage | undefined, organizationLocale?: string): string | undefined {
  if (!language?.chosen) return organizationLocale ?? language?.browser
  if (organizationLocale && resolveLanguage(organizationLocale) === language.chosen) return organizationLocale
  return LANGUAGE_LOCALES[language.chosen]
}

export function uiLanguageLocale(language: SupportedLanguage): string {
  return LANGUAGE_LOCALES[language]
}

export function saveUiLanguage(language: SupportedLanguage) {
  document.cookie = `${UI_LANGUAGE_COOKIE}=${language}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`
}
