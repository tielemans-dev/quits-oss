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

describe("agreement email total", () => {
  // A v2 offer states its own service total, with payable rounding in `gross`: the one the page
  // shows. The flat `totalGross` beside it is not what the customer is told.
  const v2Snapshot = {
    ...snapshot,
    offerFormatVersion: 2,
    totalGross: "1250.00",
    subtotalNet: "1000.00",
    totalTax: "250.00",
    serviceTotal: { net: "1000.00", tax: "250.00", gross: "1249.99", payableRounding: "-0.01", vatBasis: "gross" },
  }

  it("shows a v2 offer's service total, as the agreement page does", () => {
    const email = composeAgreementEmail({
      snapshot: v2Snapshot as never,
      number: "AGR-1",
      locale: "da-DK",
      settings: settings as never,
      recipient: "buyer@example.com",
      url: "https://app.example.test/a/token",
    })

    expect(email.html).toContain("1.249,99\u00a0kr.")
    expect(email.html).not.toContain("1.250,00")
  })

  it("shows the flat total of an older offer", () => {
    expect(compose("da-DK").html).toContain("1.250,50\u00a0kr.")
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
    expect(documentEmailOrg({ locale: "", timezone: "" }, settings)).toMatchObject({
      locale: "en-US",
      timezone: "America/New_York",
    })
  })
})
