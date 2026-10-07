import { createFileRoute, redirect, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useLayoutEffect } from 'react'
import { getSession } from '../lib/auth-session'
import { useSession } from '../lib/auth-client'
import {
  initializeRequestOrganizationId,
  useRequestOrganizationInitialized,
} from '../lib/active-organization'
import { OrganizationChangedBanner } from '../components/organization-changed-banner'
import { getActiveOrgCloudOnboardingStatus } from '../lib/cloud-onboarding-session'
import { shouldRedirectToCloudOnboarding } from '../lib/cloud-onboarding'
import { isCloudDistribution } from '../lib/distribution'
import { SidebarProvider, SidebarTrigger } from '../components/ui/sidebar'
import { AppSidebar } from '../components/app-sidebar'
import { useI18n } from '../lib/i18n/react'
import { trpc } from '../trpc/client'

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ location }) => {
    const session = await getSession()
    if (!session) {
      throw redirect({ to: '/login' })
    }
    const hasActiveOrg = !!session.session.activeOrganizationId
    // Deliberately does not set the organization this tab acts for: this also runs when a link is
    // preloaded or after another tab switched organization. The layout sets it once per page load.
    const isOnboarding = location.pathname === '/onboarding' || location.pathname.startsWith('/onboarding/')
    if (!hasActiveOrg && !isOnboarding) {
      throw redirect({ to: '/onboarding' })
    }

    if (isCloudDistribution && hasActiveOrg) {
      const onboarding = await getActiveOrgCloudOnboardingStatus()
      const redirectTo = shouldRedirectToCloudOnboarding(
        location.pathname,
        hasActiveOrg,
        onboarding.isComplete
      )
      if (redirectTo) {
        throw redirect({ to: redirectTo })
      }
    }

    return { session }
  },
  component: AppLayout,
})

function AppLayout() {
  const { setLocale } = useI18n()
  const navigate = useNavigate()
  const { data: session } = useSession()
  const { session: loadedSession } = Route.useRouteContext()
  const { location } = useRouterState()
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

  useEffect(() => {
    if (!isCloudDistribution || !activeOrgId) {
      return
    }

    let cancelled = false
    const currentPath = location.pathname

    trpc.onboarding.getStatus
      .query()
      .then((status) => {
        if (cancelled) {
          return
        }

        const redirectTo = shouldRedirectToCloudOnboarding(
          currentPath,
          true,
          status.isComplete
        )

        if (redirectTo && redirectTo !== currentPath) {
          navigate({ to: redirectTo, replace: true })
        }
      })
      .catch(() => {
        // Ignore transient onboarding status failures in the client guard.
      })

    return () => {
      cancelled = true
    }
  }, [activeOrgId, location.pathname, navigate])

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
