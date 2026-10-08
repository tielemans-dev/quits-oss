import { createFileRoute, redirect, Outlet } from '@tanstack/react-router'
import { useEffect, useLayoutEffect } from 'react'
import { getAppLayoutSession } from '../lib/auth-session'
import { reuseAppLayoutSession } from '../lib/app-layout-session'
import { useSession } from '../lib/auth-client'
import {
  initializeRequestOrganizationId,
  useRequestOrganizationInitialized,
} from '../lib/active-organization'
import { OrganizationChangedBanner } from '../components/organization-changed-banner'
import { shouldRedirectToCloudOnboarding } from '../lib/cloud-onboarding'
import { SidebarProvider, SidebarTrigger } from '../components/ui/sidebar'
import { AppSidebar } from '../components/app-sidebar'
import { useI18n } from '../lib/i18n/react'
import { trpc } from '../trpc/client'

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ location }) => {
    // One server call answers everything the layout needs, and is reused for a few seconds so
    // switching tabs and hovering links do not repeat it.
    const { session, activeOrganizationId, runtime, cloudOnboardingComplete } =
      await reuseAppLayoutSession(() => getAppLayoutSession())
    if (!session) {
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
      // Fails closed: a missing status is treated as incomplete, which sends the user to onboarding.
      const redirectTo = shouldRedirectToCloudOnboarding(
        location.pathname,
        hasActiveOrg,
        cloudOnboardingComplete === true
      )
      if (redirectTo) {
        throw redirect({ to: redirectTo })
      }
    }

    return { session, runtime }
  },
  component: AppLayout,
})

function AppLayout() {
  const { setLocale } = useI18n()
  const { data: session } = useSession()
  const { session: loadedSession } = Route.useRouteContext()
  const activeOrgId = session?.session.activeOrganizationId ?? null
  const loadedOrgId = loadedSession.session.activeOrganizationId ?? null

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
    let cancelled = false
    trpc.settings.get.query()
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
  }, [setLocale, activeOrgId])

  return (
    <SidebarProvider>
      <AppSidebar />
      <main className="flex-1 overflow-auto">
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <SidebarTrigger />
        </div>
        <OrganizationChangedBanner />
        {organizationReady ? <Outlet /> : <div aria-busy="true" className="p-6" />}
      </main>
    </SidebarProvider>
  )
}
