import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"

const testDir = dirname(fileURLToPath(import.meta.url))
const onboardingRoutePath = join(testDir, "../_app/onboarding.tsx")

describe("cloud onboarding layout", () => {
  it("adds breathing room before the submit button", () => {
    const source = readFileSync(onboardingRoutePath, "utf8")
    expect(source).toContain('<CardFooter className="pt-3">')
  })

  it("organizes cloud onboarding into confirmation and advanced sections", () => {
    const source = readFileSync(onboardingRoutePath, "utf8")
    expect(source).toContain("auth.onboarding.defaults.title")
    expect(source).toContain("auth.onboarding.advanced.title")
  })

  it("gates the ai onboarding entry on runtime capabilities", () => {
    const source = readFileSync(onboardingRoutePath, "utf8")
    expect(source).toContain("trpc.runtime.capabilities")
    expect(source).toContain("onboardingAi.enabled")
  })
})
