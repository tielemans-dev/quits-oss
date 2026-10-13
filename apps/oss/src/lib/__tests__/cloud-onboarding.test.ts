import { describe, expect, it } from "vitest"
import {
  CLOUD_ONBOARDING_VERSION,
  getCloudOnboardingState,
  getProfileDefaults,
  shouldRedirectToCloudOnboarding,
  type CloudOnboardingProfile,
} from "../cloud-onboarding"

const profiles: CloudOnboardingProfile[] = ["freelancer", "smb", "enterprise"]

describe("cloud onboarding defaults", () => {
  it("uses moms for the default business profile", () => {
    expect(getProfileDefaults("smb").taxRegime).toBe("eu_vat")
    expect(getProfileDefaults("smb", new Date(), "US").taxRegime).toBe("us_sales_tax")
  })
  it("returns defaults for each supported profile", () => {
    for (const profile of profiles) {
      const defaults = getProfileDefaults(profile)
      expect(defaults.onboardingProfile).toBe(profile)
      expect(defaults.onboardingVersion).toBe(CLOUD_ONBOARDING_VERSION)
      expect(defaults.onboardingCompletedAt).toBeInstanceOf(Date)
      expect(defaults.taxRegime.length).toBeGreaterThan(0)
      expect(defaults.invoicePrefix.length).toBeGreaterThan(0)
      expect(defaults.quotePrefix.length).toBeGreaterThan(0)
    }
  })

  it("normalizes onboarding state from org settings", () => {
    expect(getCloudOnboardingState(null)).toEqual({
      isComplete: false,
      status: "not_started",
      profile: null,
      version: null,
      completedAt: null,
    })

    const completedAt = new Date("2026-03-03T00:00:00.000Z")
    expect(
      getCloudOnboardingState({
        onboardingStatus: "complete",
        onboardingProfile: "smb",
        onboardingVersion: 1,
        onboardingCompletedAt: completedAt,
      })
    ).toEqual({
      isComplete: true,
      status: "complete",
      profile: "smb",
      version: 1,
      completedAt,
    })

    expect(
      getCloudOnboardingState({
        onboardingStatus: "in_progress",
        onboardingProfile: "unknown",
        onboardingVersion: null,
        onboardingCompletedAt: null,
      })
    ).toEqual({
      isComplete: false,
      status: "in_progress",
      profile: null,
      version: null,
      completedAt: null,
    })
  })
})

describe("cloud onboarding redirects", () => {
  it("redirects active org users to onboarding until completed", () => {
    expect(shouldRedirectToCloudOnboarding("/", true, false)).toBe("/onboarding")
    expect(shouldRedirectToCloudOnboarding("/invoices", true, false)).toBe("/onboarding")
    expect(shouldRedirectToCloudOnboarding("/onboarding", true, false)).toBeNull()
  })

  it("redirects completed users away from onboarding", () => {
    expect(shouldRedirectToCloudOnboarding("/onboarding", true, true)).toBe("/")
    expect(shouldRedirectToCloudOnboarding("/", true, true)).toBeNull()
  })

  it("does not redirect users without active organization", () => {
    expect(shouldRedirectToCloudOnboarding("/onboarding", false, false)).toBeNull()
    expect(shouldRedirectToCloudOnboarding("/", false, false)).toBeNull()
  })
})
