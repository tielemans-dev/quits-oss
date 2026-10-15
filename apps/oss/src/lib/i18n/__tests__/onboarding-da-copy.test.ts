import { describe, expect, it } from "vitest"
import { daMessages, enMessages } from "../messages"

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

  it("explains the hosted CVR requirement and free registration in both languages", () => {
    expect(daMessages["auth.onboarding.b2bOnly"]).toBe("quits er til virksomheder med CVR-nummer")
    expect(enMessages["auth.onboarding.b2bOnly"]).toBe("quits is for businesses with a CVR number")
    expect(daMessages["auth.onboarding.cvrFree"]).toContain("gratis")
    expect(enMessages["auth.onboarding.cvrFree"]).toContain("free")
    expect(enMessages["auth.onboarding.cvrLabel"]).toBe("CVR number")
  })
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
    expect(daMessages["settings.vatStatus.cvrLabel"]).toBe("CVR-nr.")
    expect(daMessages["settings.vatStatus.question"]).toBe("Er du momsregistreret?")
  })
})
