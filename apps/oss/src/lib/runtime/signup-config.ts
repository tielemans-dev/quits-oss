import { createServerFn } from "@tanstack/react-start"
import { getRuntimePlatform } from "./platform"
import { signupMode } from "./signup-admission"

export const getSignupConfiguration = createServerFn({ method: "GET" }).handler(async () => {
  const platform = getRuntimePlatform()
  const waitlist = platform.getAuthHooks().signupWaitlist
  return {
    signupMode: signupMode(platform.getEnv("SIGNUP_MODE")),
    // The component posts only to its fixed same-origin endpoint.
    waitlist: waitlist ? {
      privacyVersion: waitlist.privacyVersion,
      privacyPath: waitlist.privacyPath?.startsWith("/") && !waitlist.privacyPath.startsWith("//") && !waitlist.privacyPath.includes("\\") ? waitlist.privacyPath : "/privacy",
    } : undefined,
  }
})
