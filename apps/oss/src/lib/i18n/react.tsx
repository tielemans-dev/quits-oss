import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { resolveLanguage, translate } from "./translate"
import type { TranslationKey } from "./messages"

type I18nContextValue = {
  locale: string
  setDocumentLocale: (locale: string | null) => void
  setLocale: (locale: string) => void
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string
  /** @deprecated Use `t` with catalog keys instead of inline translation objects. */
  tm: (messages: { en: string } & Record<string, string | undefined>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

/** What the server renders with, and so what the browser's first render must start from. */
const SERVER_LOCALE = "en-US"

function detectBrowserLocale() {
  return window.navigator.language || SERVER_LOCALE
}

/**
 * Without `locale`, the language follows the signed-in organization (or the browser until it is
 * known). With `locale`, the subtree is fixed to it: the server render and the hydrated page agree
 * and the browser language is ignored. Pages for a document opened from a link use this so they
 * speak the document's language. A fixed subtree leaves `<html lang>` alone; the page marks its
 * own `lang` instead (see `LocalizedDocument`).
 */
export function I18nProvider({
  children,
  locale: fixedLocale,
  initialLocale,
}: {
  children: React.ReactNode
  locale?: string
  /** Organization locale from route context, identical on SSR and hydration; remains editable. */
  initialLocale?: string
}) {
  // The first render, on the server and in the browser, must produce the same text, so it cannot
  // read the browser's language: that would make every translated string of a non-English browser
  // differ from the server's HTML and fail hydration. The browser's language is taken right
  // after hydration instead.
  const parent = useContext(I18nContext)
  const [documentLocale, setDocumentLocale] = useState<string | null>(null)
  const [detectedLocale, setLocale] = useState<string>(initialLocale ?? SERVER_LOCALE)
  const locale = fixedLocale ?? detectedLocale
  const isFixed = fixedLocale !== undefined

  useEffect(() => {
    if (isFixed) return
    if (initialLocale) {
      // Client navigation can retain this provider while loading newly saved organization settings.
      // Only a changed route locale runs this effect, so manual edits survive ordinary rerenders.
      setLocale(initialLocale)
      return
    }
    // Keep a language that was set meanwhile (the organization's), which wins over the browser's.
    setLocale((current) => (current === SERVER_LOCALE ? detectBrowserLocale() : current))
  }, [isFixed, initialLocale])

  // Editable subtrees publish their language to the root. Only the root writes <html lang>,
  // so its browser detection cannot overwrite the loaded organization's language.
  const publishDocumentLocale = parent?.setDocumentLocale ?? setDocumentLocale
  useEffect(() => {
    if (!parent || isFixed) return
    publishDocumentLocale(locale)
    return () => publishDocumentLocale(null)
  }, [parent !== null, isFixed, locale, publishDocumentLocale])

  useEffect(() => {
    if (parent || isFixed) return
    document.documentElement.lang = resolveLanguage(documentLocale ?? locale)
  }, [parent !== null, isFixed, documentLocale, locale])

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) =>
      translate(key, locale, vars),
    [locale]
  )
  const tm = useCallback(
    (messages: { en: string } & Record<string, string | undefined>) => {
      const language = resolveLanguage(locale)
      return messages[language] ?? messages.en
    },
    [locale]
  )

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      setDocumentLocale: publishDocumentLocale,
      t,
      tm,
    }),
    [locale, t, tm, publishDocumentLocale]
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const context = useContext(I18nContext)
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider")
  }
  return context
}
