import { Link } from '@tanstack/react-router'
import { I18nProvider, useI18n } from '../../lib/i18n/react'
import { resolveLanguage } from '../../lib/i18n/translate'
import type { AuthSearch } from '../../lib/auth/navigation'
import { QuitsWordmark } from '../brand/quits-wordmark'

type AuthPath = '/login' | '/signup' | '/forgot-password' | '/reset-password'

export function AuthPage({ search = {}, path = '/signup', children }: { search?: AuthSearch; path?: AuthPath; children: React.ReactNode }) {
  const { locale } = useI18n()
  return <I18nProvider locale={search.lang ?? locale}><AuthPageContent path={path} search={search}>{children}</AuthPageContent></I18nProvider>
}

function AuthPageContent({ children, path, search }: { children: React.ReactNode; path: AuthPath; search: AuthSearch }) {
  const { locale } = useI18n()
  const language = resolveLanguage(locale)
  return <div lang={language} className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4 py-8">
    <header className="flex w-full max-w-sm items-center justify-between gap-4">
      <QuitsWordmark className="text-[26px]" />
      <nav aria-label={language === 'da' ? 'Sprog' : 'Language'} className="flex gap-1 text-sm">
        {(['da', 'en'] as const).map((lang) => <Link key={lang} to={path} search={{ ...search, lang }}
          lang={lang} aria-label={lang === 'da' ? 'Dansk' : 'English'} aria-current={language === lang ? 'true' : undefined}
          className="flex min-h-11 min-w-11 items-center justify-center underline underline-offset-4">{lang.toUpperCase()}</Link>)}
      </nav>
    </header>
    {children}
  </div>
}
