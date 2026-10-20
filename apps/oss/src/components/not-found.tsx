import { Link } from '@tanstack/react-router'
import { Button } from './ui/button'
import { useI18n } from '../lib/i18n/react'
import { cn } from '../lib/utils'

/**
 * The 404 page. Outside the app it fills the screen in the browser's language; inside the app
 * (`inApp`) it sits in the shell, in the organization's language, so the sidebar stays usable.
 */
export function NotFoundPage({ inApp = false }: { inApp?: boolean }) {
  const { t } = useI18n()

  return (
    <main className={cn('flex max-w-md flex-col', inApp ? 'pt-16' : 'mx-auto min-h-screen justify-center px-6')}>
      <p className="text-muted-foreground font-mono text-xs">404</p>
      <h1 className="mt-2 text-2xl font-medium tracking-[-0.01em]">{t('root.notFound.title')}</h1>
      <p className="text-muted-foreground mt-2 text-sm">{t('root.notFound.body')}</p>
      <Button asChild className="mt-6 self-start">
        <Link to="/">{t('root.notFound.goHome')}</Link>
      </Button>
    </main>
  )
}
