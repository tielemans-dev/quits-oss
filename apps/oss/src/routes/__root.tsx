import { HeadContent, Scripts, createRootRoute, Link, redirect } from '@tanstack/react-router'
import { ThemeProvider } from '../components/theme-provider'
import { TooltipProvider } from '../components/ui/tooltip'
import { useI18n, I18nProvider } from '../lib/i18n/react'
import { getInstallationStatus, normalizeInstallationStatus } from '../lib/installation'
import { shouldRedirectToSetup } from '../lib/setup-guard'
import { THEME_COLORS, themeInitScript } from '../lib/theme'

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
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
      { rel: 'apple-touch-icon', href: '/logo192.png' },
      { rel: 'manifest', href: '/manifest.json' },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    // The head script puts the theme's `dark` class on <html> before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* One tag: the head script (and applyTheme) set its colour from the resolved theme. */}
        <meta name="theme-color" content={THEME_COLORS.light} suppressHydrationWarning />
        {/* After HeadContent so the charset meta stays near the top; the stylesheet blocks first paint anyway. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <I18nProvider>
          <ThemeProvider>
            <TooltipProvider>
              {children}
            </TooltipProvider>
          </ThemeProvider>
        </I18nProvider>
        <Scripts />
      </body>
    </html>
  )
}
