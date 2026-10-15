import { describe, expect, it } from "vitest"
import {
  buildSetupInitializePayload,
  deriveInitialStep,
  slugifyOrganizationName,
} from "../../components/setup/setup-wizard"

describe("setup route helpers", () => {
  it("derives the correct initial step from setup stage", () => {
    expect(deriveInitialStep("new")).toBe(1)
    expect(deriveInitialStep("initialized")).toBe(4)
    expect(deriveInitialStep("complete")).toBe(4)
  })

  it("slugifies organization names for default setup slug", () => {
    expect(slugifyOrganizationName("Acme Consulting ApS")).toBe("acme-consulting-aps")
    expect(slugifyOrganizationName("  Hello__World!!  ")).toBe("hello-world")
  })

  it("builds initialize payload with normalized values", () => {
    const payload = buildSetupInitializePayload({
      instanceProfile: "smb",
      organizationName: "  Acme ApS ",
      organizationSlug: "acme-aps ",
      adminName: "  Jane Doe ",
      adminEmail: "  ADMIN@EXAMPLE.COM ",
      adminPassword: "Passw0rd!234",
      authMode: "local_only",
      locale: " en-US ",
      countryCode: "dk",
      timezone: " Europe/Copenhagen ",
      currency: "dkk",
      emailFromName: "Acme Billing",
      emailReplyTo: "billing@example.com",
    })

    expect(payload).toEqual({
      instanceProfile: "smb",
      organization: {
        name: "Acme ApS",
        slug: "acme-aps",
      },
      admin: {
        name: "Jane Doe",
        email: "admin@example.com",
        password: "Passw0rd!234",
      },
      auth: {
        mode: "local_only",
      },
      locale: {
        locale: "en-US",
        countryCode: "DK",
        timezone: "Europe/Copenhagen",
        currency: "DKK",
      },
      email: {
        fromName: "Acme Billing",
        replyTo: "billing@example.com",
      },
    })
  })
})
