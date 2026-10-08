import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { resolveLanguage, translate } from "./translate"
import type { TranslationKey } from "./messages"

type I18nContextValue = {
  locale: string
  setLocale: (locale: string) => void
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string
  /** @deprecated Use `t` with catalog keys instead of inline translation objects. */
  tm: (messages: { en: string } & Record<string, string | undefined>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

function detectInitialLocale() {
  if (typeof window === "undefined") return "en-US"
  return window.navigator.language || "en-US"
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
}: {
  children: React.ReactNode
  locale?: string
}) {
  const [detectedLocale, setLocale] = useState<string>(detectInitialLocale)
  const locale = fixedLocale ?? detectedLocale
  const isFixed = fixedLocale !== undefined

  useEffect(() => {
    if (isFixed) return
    if (typeof document !== "undefined") {
      document.documentElement.lang = resolveLanguage(locale)
    }
  }, [isFixed, locale])

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
      t,
      tm,
    }),
    [locale, t, tm]
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
