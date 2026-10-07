import { describe, expect, it } from "vitest"
import { setupInitializeSchema } from "../validators"

const input = (countryCode: string) => ({
  instanceProfile: "smb",
  organization: { name: "Acme", slug: "acme" },
  admin: { name: "Admin", email: "admin@example.com", password: "Passw0rd!234" },
  auth: { mode: "local_only" },
  locale: { locale: "en-GB", countryCode, timezone: "UTC", currency: "GBP" },
})

describe("setupInitializeSchema", () => {
  it("accepts any ISO country, including ones without a module", () => {
    expect(setupInitializeSchema.parse(input("gb")).locale.countryCode).toBe("GB")
  })

  it("rejects codes that name no country", () => {
    for (const countryCode of ["ZZ", "EU", "XX"]) {
      expect(setupInitializeSchema.safeParse(input(countryCode)).success).toBe(false)
    }
  })
})
