import { createServerFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import type { AppLayoutUser } from "./app-layout-session"
import { loadCloudOnboardingState } from "./cloud-onboarding-session"
import { readRuntimeDistribution } from "./runtime-distribution"

/**
 * Everything the app layout needs before a navigation commits, in one server round trip: who is
 * signed in, their active organization, how this server is deployed (the browser cannot tell), and
 * on cloud whether the active organization has finished onboarding. The session is read once and
 * shared by both checks.
 *
 * This is route context, which TanStack dehydrates into the server-rendered HTML, so it carries
 * only what the browser uses: the user's display fields and the active organization id. The
 * session record itself holds the session token and the client's address and user agent; those
 * stay on the server (the token is otherwise only in an httpOnly cookie, out of reach of scripts).
 */
export const getAppLayoutSession = createServerFn({ method: "GET" }).handler(async () => {
  const { auth } = await import("./auth")
  const session = await auth.api.getSession({ headers: getRequestHeaders() })
  const runtime = readRuntimeDistribution()
  const user: AppLayoutUser | null = session?.user
    ? {
        id: session.user.id,
        name: session.user.name ?? null,
        email: session.user.email ?? null,
        image: session.user.image ?? null,
      }
    : null
  const activeOrganizationId =
    session?.session &&
    "activeOrganizationId" in session.session &&
    typeof session.session.activeOrganizationId === "string"
      ? session.session.activeOrganizationId
      : null

  if (runtime.distribution !== "cloud" || !activeOrganizationId) {
    return { user, activeOrganizationId, runtime, cloudOnboardingComplete: null }
  }

  const onboarding = await loadCloudOnboardingState(activeOrganizationId)
  return { user, activeOrganizationId, runtime, cloudOnboardingComplete: onboarding.isComplete }
})
