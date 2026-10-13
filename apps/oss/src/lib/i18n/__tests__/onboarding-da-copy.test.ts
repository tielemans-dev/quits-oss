import { describe, expect, it } from "vitest"
import { daMessages } from "../messages"

const english = [
  "Finish onboarding",
  "VAT/CVR",
  "EU VAT",
  "Tax setup",
  "Company name",
  "Company address",
  "Billing email",
  "workspace",
  "Slug",
  " onboarding",
  "cloud",
]

describe("Danish onboarding copy", () => {
  const entries = Object.entries(daMessages).filter(([key]) => key.startsWith("auth.onboarding."))

  it("translates every onboarding string and uses moms and CVR-nr.", () => {
    expect(entries.length).toBeGreaterThan(40)
    for (const [key, value] of entries) {
      for (const phrase of english) {
        expect(String(value).toLowerCase(), key).not.toContain(phrase.toLowerCase())
      }
    }
    expect(daMessages["auth.onboarding.primary.dkLabel"]).toBe("CVR-nr.")
    expect(daMessages["auth.onboarding.field.primaryTaxId"]).toBe("CVR-nr.")
    expect(daMessages["auth.onboarding.regime.euVat"]).toBe("Moms (25 %)")
    expect(daMessages["auth.onboarding.field.taxRegime"]).toBe("Moms")
    expect(daMessages["auth.onboarding.finish.submit"]).toBe("Afslut opsætning")
    expect(daMessages["settings.vatStatus.cvrLabel"]).toBe("CVR-nummer")
    expect(daMessages["settings.vatStatus.question"]).toBe("Er du momsregistreret?")
  })
})
