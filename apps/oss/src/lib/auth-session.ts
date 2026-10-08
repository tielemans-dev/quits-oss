import { createServerFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { loadCloudOnboardingState } from "./cloud-onboarding-session"
import { readRuntimeDistribution } from "./runtime-distribution"

/**
 * Everything the app layout needs before a navigation commits, in one server round trip: the
 * session, its active organization, how this server is deployed (the browser cannot tell), and on
 * cloud whether the active organization has finished onboarding. The session is read once and
 * shared by both checks.
 */
export const getAppLayoutSession = createServerFn({ method: "GET" }).handler(async () => {
  const { auth } = await import("./auth")
  const session = await auth.api.getSession({ headers: getRequestHeaders() })
  const runtime = readRuntimeDistribution()
  const activeOrganizationId =
    session?.session &&
    "activeOrganizationId" in session.session &&
    typeof session.session.activeOrganizationId === "string"
      ? session.session.activeOrganizationId
      : null

  if (runtime.distribution !== "cloud" || !activeOrganizationId) {
    return { session, activeOrganizationId, runtime, cloudOnboardingComplete: null }
  }

  const onboarding = await loadCloudOnboardingState(activeOrganizationId)
  return { session, activeOrganizationId, runtime, cloudOnboardingComplete: onboarding.isComplete }
})
