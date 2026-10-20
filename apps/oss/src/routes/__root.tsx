import { useEffect } from 'react'
import { HeadContent, Scripts, createRootRoute, Link, redirect, useRouterState } from '@tanstack/react-router'
import { ThemeProvider } from '../components/theme-provider'
import { TooltipProvider } from '../components/ui/tooltip'
import { Button } from '../components/ui/button'
import { useI18n, I18nProvider } from '../lib/i18n/react'
import { resolveLanguage } from '../lib/i18n/translate'
import { getInstallationStatus, normalizeInstallationStatus } from '../lib/installation'
import type { InstallationStatus } from '../lib/installation-state'
import { rememberInstallationStatus, reuseInstallationStatus } from '../lib/installation-cache'
import { SETUP_DEFAULT_LOCALE } from '../lib/setup-locale'
import { parseUiLanguage, readUiLanguage, saveUiLanguage, uiLocale, type UiLanguage } from '../lib/i18n/ui-language'
import { shouldRedirectToSetup } from '../lib/setup-guard'
import { themeInitScript } from '../lib/theme'

import appCss from '../styles.css?url'
import geistFontUrl from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url'
import geistMonoFontUrl from '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url'

function NotFound() {
  const { t } = useI18n()

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <p className="text-muted-foreground font-mono text-xs">404</p>
      <h1 className="mt-2 text-2xl font-medium tracking-[-0.01em]">{t('root.notFound.title')}</h1>
      <p className="text-muted-foreground mt-2 text-sm">{t('root.notFound.body')}</p>
      <Button asChild className="mt-6 self-start">
        <Link to="/">{t('root.notFound.goHome')}</Link>
      </Button>
    </main>
  )
}

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    // Public examples never query installation state or populate its production cache.
    if (location.pathname === '/demo' || location.pathname.startsWith('/demo/')) {
      return { installation: undefined }
    }
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
    // Every page renders in the language from `?lang`, the saved choice or the browser, on the
    // server too, so the first paint is already in it.
    return { installation, language: readUiLanguage(location.search) }
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
      { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      { rel: 'icon', href: '/favicon-32.png', type: 'image/png', sizes: '32x32' },
      { rel: 'icon', href: '/favicon-16.png', type: 'image/png', sizes: '16x16' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
      { rel: 'manifest', href: '/site.webmanifest' },
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
  const language = useRouterState({
    select: (state) => (state.matches[0]?.context as { language?: UiLanguage } | undefined)?.language,
  })
  // The loaded app context is available to the shell on SSR and hydration. Read only the
  // editable app locale: public documents mark their fixed language on their own wrapper.
  // First-run setup has no organization yet; its page speaks the setup default.
  const setup = useRouterState({ select: (state) => state.matches.some((match) => match.routeId === '/setup') })
  const organizationLocale = useRouterState({
    select: (state) => (state.matches.find((match) => match.routeId === '/_app')?.context as { locale?: string } | undefined)?.locale,
  })
  const locale = setup ? SETUP_DEFAULT_LOCALE : uiLocale(language, organizationLocale)
  // A `?lang` the page was opened with, such as from the landing page, is kept for later pages.
  const requestedLanguage = useRouterState({
    select: (state) => parseUiLanguage((state.location.search as { lang?: unknown }).lang),
  })
  useEffect(() => {
    if (requestedLanguage) saveUiLanguage(requestedLanguage)
  }, [requestedLanguage])
  useEffect(() => {
    rememberInstallationStatus(installation)
  }, [installation])

  return (
    // The head script puts the theme's `dark` class on <html> before React hydrates.
    <html lang={resolveLanguage(locale)} suppressHydrationWarning>
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
        <I18nProvider initialLocale={uiLocale(language)}>
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
