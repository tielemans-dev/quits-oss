import type { ReactNode } from "react"
import { I18nProvider } from "../../lib/i18n/react"
import { resolveLanguage } from "../../lib/i18n/translate"

/**
 * Renders a page for a document opened from a link in the document's own language.
 *
 * The locale is fixed for the whole subtree, so the server render and the hydrated page show the
 * same text whatever the visitor's browser prefers. `lang` carries the full tag ("da-DK"), not just the language, and marks the language of the content for
 * screen readers and browser translation; `display: contents` keeps the wrapper out of the layout.
 */
export function LocalizedDocument({ locale, children }: { locale: string; children: ReactNode }) {
  // The full tag, unless the text is not in that language: a document in a language without a
  // catalog is shown in English, and marking English text as Dutch misleads screen readers.
  const language = resolveLanguage(locale)
  const lang = locale.split("-")[0]?.toLowerCase() === language ? locale : language

  return (
    <I18nProvider locale={locale}>
      <div lang={lang} className="contents">
        {children}
      </div>
    </I18nProvider>
  )
}
