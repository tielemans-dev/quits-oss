import type { ReactNode } from "react"
import { I18nProvider } from "../../lib/i18n/react"
import { resolveLanguage } from "../../lib/i18n/translate"

/**
 * Renders a page for a document opened from a link in the document's own language.
 *
 * The locale is fixed for the whole subtree, so the server render and the hydrated page show the
 * same text whatever the visitor's browser prefers. `lang` marks the language of the content for
 * screen readers and browser translation; `display: contents` keeps the wrapper out of the layout.
 */
export function LocalizedDocument({ locale, children }: { locale: string; children: ReactNode }) {
  return (
    <I18nProvider locale={locale}>
      <div lang={resolveLanguage(locale)} className="contents">
        {children}
      </div>
    </I18nProvider>
  )
}
