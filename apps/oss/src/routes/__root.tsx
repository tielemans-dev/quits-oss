import { useEffect } from 'react'
import { HeadContent, Scripts, createRootRoute, Link, redirect, useRouterState } from '@tanstack/react-router'
import { ThemeProvider } from '../components/theme-provider'
import { TooltipProvider } from '../components/ui/tooltip'
import { useI18n, I18nProvider } from '../lib/i18n/react'
import { getInstallationStatus, normalizeInstallationStatus } from '../lib/installation'
import type { InstallationStatus } from '../lib/installation-state'
import { rememberInstallationStatus, reuseInstallationStatus } from '../lib/installation-cache'
import { shouldRedirectToSetup } from '../lib/setup-guard'
import { themeInitScript } from '../lib/theme'

import appCss from '../styles.css?url'
import geistFontUrl from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url'
import geistMonoFontUrl from '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url'

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
    const installation = await reuseInstallationStatus(async () =>
      normalizeInstallationStatus(await getInstallationStatus())
    )
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
      // The latin subsets that the @font-face rules in styles.css load first, so text does not
      // swap fonts after first paint. Fonts need `crossOrigin` even when same-origin.
      ...[geistFontUrl, geistMonoFontUrl].map((href) => ({
        rel: 'preload',
        as: 'font',
        type: 'font/woff2',
        href,
        crossOrigin: 'anonymous' as const,
      })),
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
  // A server-rendered page already holds the installation answer; keep it so the first client
  // navigation does not ask the server again.
  const installation = useRouterState({
    select: (state) => (state.matches[0]?.context as { installation?: InstallationStatus } | undefined)?.installation,
  })
  useEffect(() => {
    rememberInstallationStatus(installation)
  }, [installation])

  return (
    // The head script puts the theme's `dark` class on <html> before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/*
          The head script creates the one theme-color meta from the resolved theme, and applyTheme
          keeps it current. React does not render it: React 19 hoists <meta> elements, so on
          hydration it would add a second tag next to the one the script changed.
          After HeadContent so the charset meta stays near the top; the stylesheet blocks first paint anyway.
        */}
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
