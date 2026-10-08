import { useI18n } from '../../lib/i18n/react'

/** The first thing a keyboard reaches: jumps over the sidebar to the page (`#main-content`). */
export function SkipLink() {
  const { t } = useI18n()
  return (
    <a
      href="#main-content"
      className="sr-only rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50"
    >
      {t('shell.skipToContent')}
    </a>
  )
}
