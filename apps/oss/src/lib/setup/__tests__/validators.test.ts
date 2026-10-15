import { describe, expect, it } from "vitest"
import { setupInitializeSchema } from "../validators"

const input = (countryCode: string, locale = "en-GB") => ({
  instanceProfile: "smb",
  organization: { name: "Acme", slug: "acme" },
  admin: { name: "Admin", email: "admin@example.com", password: "Passw0rd!234" },
  auth: { mode: "local_only" },
  locale: { locale, countryCode, timezone: "UTC", currency: "GBP" },
})

describe("setupInitializeSchema", () => {
  it("accepts any ISO country, including ones without a module", () => {
    expect(setupInitializeSchema.parse(input("gb")).locale.countryCode).toBe("GB")
  })

  it("accepts formattable locales the settings page can save back", () => {
    expect(setupInitializeSchema.parse(input("PL", "pl-PL")).locale.locale).toBe("pl-PL")
    expect(setupInitializeSchema.safeParse(input("PL", "foo")).success).toBe(false)
  })

  it("rejects codes that name no country", () => {
    for (const countryCode of ["ZZ", "EU", "XX", "UK"]) {
      expect(setupInitializeSchema.safeParse(input(countryCode)).success).toBe(false)
    }
  })
})
