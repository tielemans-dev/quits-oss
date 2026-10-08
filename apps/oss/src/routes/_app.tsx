import { createFileRoute, redirect, Outlet } from '@tanstack/react-router'
import { useEffect, useLayoutEffect } from 'react'
import { getAppLayoutSession } from '../lib/auth-session'
import {
  invalidateAppLayoutSessionUnlessUser,
  reuseAppLayoutSession,
  seedAppLayoutSession,
} from '../lib/app-layout-session'
import { useSession } from '../lib/auth-client'
import {
  initializeRequestOrganizationId,
  useRequestOrganizationInitialized,
} from '../lib/active-organization'
import { OrganizationChangedBanner } from '../components/organization-changed-banner'
import { shouldRedirectToCloudOnboarding } from '../lib/cloud-onboarding'
import { SidebarProvider } from '../components/ui/sidebar'
import { AppSidebar } from '../components/app-sidebar'
import { AppMain } from '../components/shell/app-main'
import { useI18n } from '../lib/i18n/react'
import { loadOrganizationSettings } from '../lib/organization-settings-query'

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ location }) => {
    // One server call answers everything the layout needs, and is reused for a few seconds so
    // switching tabs and hovering links do not repeat it.
    const { user, activeOrganizationId, runtime, cloudOnboardingComplete } =
      await reuseAppLayoutSession(() => getAppLayoutSession())
    if (!user) {
      throw redirect({ to: '/login' })
    }
    const hasActiveOrg = !!activeOrganizationId
    // Deliberately does not set the organization this tab acts for: this also runs when a link is
    // preloaded or after another tab switched organization. The layout sets it once per page load.
    const isOnboarding = location.pathname === '/onboarding' || location.pathname.startsWith('/onboarding/')
    if (!hasActiveOrg && !isOnboarding) {
      throw redirect({ to: '/onboarding' })
    }

    // The server decides whether this is cloud: the browser has no runtime environment to ask.
    if (runtime.distribution === 'cloud' && hasActiveOrg) {
      // On cloud with an active organization the server always answers true or false; anything
      // else would be treated as incomplete, which sends the user to onboarding.
      const redirectTo = shouldRedirectToCloudOnboarding(
        location.pathname,
        hasActiveOrg,
        cloudOnboardingComplete === true
      )
      if (redirectTo) {
        throw redirect({ to: redirectTo })
      }
    }

    // Route context is rendered into the server's HTML, so it holds only what the browser uses.
    return { user, activeOrganizationId, runtime, cloudOnboardingComplete }
  },
  component: AppLayout,
})

function AppLayout() {
  const { setLocale } = useI18n()
  const { data: session, isPending } = useSession()
  const layoutContext = Route.useRouteContext()
  const loadedOrgId = layoutContext.activeOrganizationId ?? null
  const sessionUserId = session?.user?.id ?? null

  // After a server render the browser already holds the layout's answer: start the reuse cache
  // from it so the first client navigation does not ask again.
  useEffect(() => {
    seedAppLayoutSession(layoutContext)
    // Once per mount, with the context this layout first committed.
  }, [])

  // The live session is the nearest the browser gets to the session cookie (which it cannot
  // read): if it names another user than the cached answer, the cached answer must go.
  useEffect(() => {
    if (!isPending) invalidateAppLayoutSessionUnlessUser(sessionUserId)
  }, [isPending, sessionUserId])

  // The organization this tab acts for is set once per page load, here, when the layout first
  // commits; later commits (session refetches after another tab switched organization) keep it,
  // and switching organization loads a new page. Pages render only once it is set, so their own
  // requests always name it. Before that the server and the hydrating client both render the
  // placeholder, so hydration matches.
  const organizationReady = useRequestOrganizationInitialized()
  useLayoutEffect(() => {
    initializeRequestOrganizationId(loadedOrgId)
  }, [loadedOrgId])

  useEffect(() => {
    if (!organizationReady || !loadedOrgId) return
    let cancelled = false
    loadOrganizationSettings()
      .then((settings) => {
        if (!cancelled && settings.locale) {
          setLocale(settings.locale)
        }
      })
      .catch(() => {
        // Keep browser locale when settings are not yet available.
      })

    return () => {
      cancelled = true
    }
  }, [setLocale, organizationReady, loadedOrgId])

  return (
    <SidebarProvider>
      <AppSidebar />
      <AppMain banner={<OrganizationChangedBanner />}>
        {organizationReady ? <Outlet /> : <div aria-busy="true" className="p-6" />}
      </AppMain>
    </SidebarProvider>
  )
}
