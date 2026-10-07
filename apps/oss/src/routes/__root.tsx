import { HeadContent, Scripts, createRootRoute, Link, redirect } from '@tanstack/react-router'
import { TooltipProvider } from '../components/ui/tooltip'
import { useI18n, I18nProvider } from '../lib/i18n/react'
import { getInstallationStatus, normalizeInstallationStatus } from '../lib/installation'
import { shouldRedirectToSetup } from '../lib/setup-guard'

import appCss from '../styles.css?url'

function NotFound() {
  const { t } = useI18n()

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="text-muted-foreground">{t('root.notFound.title')}</p>
      <Link to="/" className="underline text-sm">{t('root.notFound.goHome')}</Link>
    </div>
  )
}

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    const installation = normalizeInstallationStatus(await getInstallationStatus())
    if (
      shouldRedirectToSetup(
        location.pathname,
        installation.isSetupComplete,
        installation.distribution
      )
    ) {
      throw redirect({ to: '/setup' })
    }
    return { installation }
  },
  notFoundComponent: NotFound,
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'Quits',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <I18nProvider>
          <TooltipProvider>
            {children}
          </TooltipProvider>
        </I18nProvider>
        <Scripts />
      </body>
    </html>
  )
}
