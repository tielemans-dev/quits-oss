import { createFileRoute, redirect, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import { getSession } from '../lib/auth-session'
import { useSession } from '../lib/auth-client'
import { setRequestOrganizationId } from '../lib/active-organization'
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
    // The pages below load data for this organization, so requests from them are sent for it.
    setRequestOrganizationId(session.session.activeOrganizationId)
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

  // Covers the hydrated first render, where the route context comes from the server. A session
  // refresh alone (for example a switch in another tab) deliberately does not change it: the
  // server then rejects requests from this page instead of applying them to the other organization.
  useEffect(() => {
    setRequestOrganizationId(loadedOrgId)
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
        <Outlet />
      </main>
    </SidebarProvider>
  )
}
