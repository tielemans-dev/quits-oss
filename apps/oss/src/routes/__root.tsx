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
import { authShellLanguage, onboardingShellLanguage } from '../lib/login-return'
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

/** Pages opened from a link to one document, each rendered in that document's language. */
const PUBLIC_DOCUMENT_ROUTES = new Set<string>(['/pay/$token', '/q/$token', '/a/$token', '/reminders/unsubscribe'])

function RootDocument({ children }: { children: React.ReactNode }) {
  // A server-rendered page already holds the installation answer; keep it so the first client
  // navigation does not ask the server again.
  const installation = useRouterState({
    select: (state) => (state.matches[0]?.context as { installation?: InstallationStatus } | undefined)?.installation,
  })
  // The loaded app context is available to the shell on SSR and hydration.
  const locale = useRouterState({
    select: (state) => {
      // A public document speaks the language its loader chose on the server, not the app's.
      const publicDocument = state.matches.find((match) => PUBLIC_DOCUMENT_ROUTES.has(match.routeId))
      if (publicDocument) return (publicDocument.loaderData as { locale?: string } | undefined)?.locale
      // First-run setup has no organization yet; its page speaks the setup default.
      return state.matches.some((match) => match.routeId === '/setup')
        ? SETUP_DEFAULT_LOCALE
        // Onboarding and the auth pages opened with `lang` render in it, so the document must say so.
        : onboardingShellLanguage(state.location.pathname, state.location.search) ??
          authShellLanguage(state.location.pathname, state.location.search) ??
          (state.matches.find((match) => match.routeId === '/_app')?.context as { locale?: string } | undefined)?.locale
    },
  })
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
