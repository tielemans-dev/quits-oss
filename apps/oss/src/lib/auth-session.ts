import { createServerFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { isCloudDistribution } from "./distribution"
import { loadCloudOnboardingState } from "./cloud-onboarding-session"

/**
 * Everything the app layout needs before a navigation commits, in one server round trip: the
 * session, and on cloud whether the active organization has finished onboarding. The session is
 * read once and shared by both checks.
 */
export const getAppLayoutSession = createServerFn({ method: "GET" }).handler(async () => {
  const { auth } = await import("./auth")
  const session = await auth.api.getSession({ headers: getRequestHeaders() })
  const organizationId =
    session?.session &&
    "activeOrganizationId" in session.session &&
    typeof session.session.activeOrganizationId === "string"
      ? session.session.activeOrganizationId
      : null

  if (!isCloudDistribution || !organizationId) {
    return { session, cloudOnboardingComplete: null }
  }

  const onboarding = await loadCloudOnboardingState(organizationId)
  return { session, cloudOnboardingComplete: onboarding.isComplete }
})
