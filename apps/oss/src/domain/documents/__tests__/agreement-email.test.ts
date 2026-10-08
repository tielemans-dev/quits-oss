import { describe, expect, it } from "vitest"
import { composeAgreementEmail } from "../agreement-email"
import { documentEmailOrg } from "../invoice-email"

const settings = {
  companyName: "Acme",
  companyEmail: "billing@acme.com",
  locale: "en-US",
  timezone: "America/New_York",
  documentSendingDomain: null,
  documentSendingDomainStatus: null,
  stripePublishableKey: null,
  stripeSecretKeyEnc: null,
  stripeWebhookSecretEnc: null,
}

const snapshot = {
  title: "Website",
  summary: "Build the site",
  totalGross: "1250.5",
  currency: "DKK",
  termsHtml: "<p>Terms</p>",
}

function compose(locale: string, accepted?: boolean) {
  return composeAgreementEmail({
    snapshot: snapshot as never,
    number: "AGR-1",
    locale,
    settings: settings as never,
    recipient: "buyer@example.com",
    url: "https://app.example.test/a/token",
    accepted,
  })
}

describe("agreement email language", () => {
  it("is written in the agreement's language whatever the organization uses now", () => {
    const offer = compose("da-DK")
    expect(offer.subject).toBe("Aftale AGR-1: Website")
    expect(offer.html).toContain("Gennemgå aftalen")
    expect(offer.html).toContain("1.250,50\u00a0kr.")
    expect(offer.html).not.toContain("Review agreement")

    const accepted = compose("da-DK", true)
    expect(accepted.subject).toBe("Aftale accepteret AGR-1: Website")
    expect(accepted.html).toContain("Læs den accepterede aftale")
  })

  it("keeps English for an English agreement", () => {
    const offer = compose("en-US")
    expect(offer.subject).toBe("Agreement AGR-1: Website")
    expect(offer.html).toContain("Review agreement")
    expect(offer.html).toContain("DKK")
  })
})

describe("documentEmailOrg", () => {
  it("prefers the document's language and timezone", () => {
    expect(documentEmailOrg({ locale: "da-DK", timezone: "Europe/Copenhagen" }, settings)).toMatchObject({
      locale: "da-DK",
      timezone: "Europe/Copenhagen",
    })
  })

  it("falls back to the organization for a legacy document", () => {
    expect(documentEmailOrg({ locale: "", timezone: null }, settings)).toMatchObject({
      locale: "en-US",
      timezone: "America/New_York",
    })
  })
})
