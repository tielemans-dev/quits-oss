import { MutationErrors } from "../components/query-state"
import { createFileRoute, redirect, Outlet, useLocation } from '@tanstack/react-router'
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
import '../components/command-bar/register-cards'
import { AppMain } from '../components/shell/app-main'
import { I18nProvider } from '../lib/i18n/react'
import { uiLocale } from '../lib/i18n/ui-language'
import { loginRedirectHref, loginReturnOnboarding, loginReturnSearchSchema, loginReturnTarget, loginReturnDestination } from '../lib/login-return'
import { ReminderTracker } from '../components/jobs/reminder-tracker'
import { UndoToaster } from '../components/undo/undo-toaster'
import { TrialAccessProvider, TrialBanner, TrialRouteGate } from '../components/billing/trial-access'

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ location }) => {
    // One server call answers everything the layout needs, and is reused for a few seconds so
    // switching tabs and hovering links do not repeat it.
    const { user, activeOrganizationId, runtime, locale, cloudOnboardingComplete } =
      await reuseAppLayoutSession(() => getAppLayoutSession())
    if (!user) {
      throw redirect({ href: loginRedirectHref(location.href, loginReturnSearchSchema.parse(location.search).lang) })
    }
    const hasActiveOrg = !!activeOrganizationId
    // Deliberately does not set the organization this tab acts for: this also runs when a link is
    // preloaded or after another tab switched organization. The layout sets it once per page load.
    const isOnboarding = location.pathname === '/onboarding' || location.pathname.startsWith('/onboarding/')
    if (!hasActiveOrg && !isOnboarding) {
      throw redirect({ href: loginReturnOnboarding({ next: location.href, lang: loginReturnSearchSchema.parse(location.search).lang }) })
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
      if (redirectTo === '/') {
        const search = loginReturnSearchSchema.parse(location.search)
        const requestedTarget = loginReturnTarget(search)
        // Completed onboarding cannot return to itself and repeatedly run this guard.
        const targetPath = requestedTarget?.split(/[?#]/)[0]
        const target = targetPath === '/onboarding' || targetPath?.startsWith('/onboarding/') ? null : requestedTarget
        if (target || search.lang) throw redirect({ href: loginReturnDestination(target ?? '/', search.lang) })
        throw redirect({ to: '/' })
      }
      if (redirectTo) {
        throw redirect({ href: loginReturnOnboarding({ next: location.href, lang: loginReturnSearchSchema.parse(location.search).lang }) })
      }
    }

    // Route context is rendered into the server's HTML, so it holds only what the browser uses.
    return { user, activeOrganizationId, runtime, locale, cloudOnboardingComplete }
  },
  component: AppLayout,
})

function AppLayout() {
  // The person's chosen language wins over the organization's; see `uiLocale`.
  const { language, locale } = Route.useRouteContext()
  return <I18nProvider initialLocale={uiLocale(language, locale)}><AppLayoutContent /></I18nProvider>
}

function AppLayoutContent() {
  const pathname = useLocation({ select: location => location.pathname })
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

  const hasOrganization = Boolean(loadedOrgId)
  const onboardingPending = hasOrganization && layoutContext.runtime.distribution === 'cloud' && layoutContext.cloudOnboardingComplete !== true
  return (
    <SidebarProvider>
      {hasOrganization ? <AppSidebar /> : null}
      <TrialAccessProvider onboardingPending={onboardingPending}>
        <AppMain sidebar={hasOrganization} banner={<><OrganizationChangedBanner /><TrialBanner /></>}>
          {organizationReady ? <TrialRouteGate pathname={pathname}><MutationErrors /><Outlet /></TrialRouteGate> : <div aria-busy="true" className="p-6" />}
        </AppMain>
      </TrialAccessProvider>
      {hasOrganization && organizationReady ? <><ReminderTracker /><UndoToaster /></> : null}
    </SidebarProvider>
  )
}
