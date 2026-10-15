import { describe, expect, it } from "vitest"
import { composeAgreementEmail } from "../agreement-email"
import { documentEmailOrg } from "../invoice-email"
import fixture from "../../agreements/__tests__/fixtures/offer-v2.json"
import { agreementOfferSnapshotV2Schema } from "@quits/contracts/agreements"

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
  const v2Snapshot = agreementOfferSnapshotV2Schema.parse({
    ...fixture.snapshot,
    title: snapshot.title,
    totalGross: "1250.00",
  })

  it("shows a v2 offer's service total, as the agreement page does", () => {
    const email = composeAgreementEmail({
      snapshot: v2Snapshot,
      number: "AGR-1",
      locale: "da-DK",
      settings: settings as never,
      recipient: "buyer@example.com",
      url: "https://app.example.test/a/token",
    })

    expect(email.html).toContain("0,02\u00a0kr.")
    expect(email.html).not.toContain("1.250,00")
  })

  it("lists each VAT row and its classification, as the agreement page does", () => {
    const [standard] = v2Snapshot.vatGroups
    const exempt = { ...standard!, treatment: "exempt", rate: "0", key: "[\"exempt\",null,\"0\",null]", tax: "0.00", taxBase: "0.00", payableRounding: "0.00", payableRoundingBase: "0.00" }
    const email = composeAgreementEmail({
      snapshot: { ...v2Snapshot, vatGroups: [standard!, exempt] } as never,
      number: "AGR-1",
      locale: "da-DK",
      settings: settings as never,
      recipient: "buyer@example.com",
      url: "https://app.example.test/a/token",
    })

    expect(email.html).toContain("Moms 25 % af")
    expect(email.html).toContain("Moms 0 % af")
    expect(email.html).toContain("Momsfritaget")
  })

  it("includes frozen party identities and escapes required statements", () => {
    const email = composeAgreementEmail({
      snapshot: { ...v2Snapshot,
        sellerSnapshot: { companyName: "Frozen Seller", companyEmail: "frozen@example.test", companyAddress: "Seller Street", momsRegistered: true, taxIds: [{ scheme: "dk_vat", value: "DK12345678" }] },
        buyerSnapshot: { name: "Frozen Buyer", company: "Frozen Buyer", address: "Buyer Street", zip: "2200", city: "København N", country: "DK", email: "buyer@example.test", taxIds: [{ scheme: "cvr", value: "87654321" }] },
        vatGroups: [{ ...v2Snapshot.vatGroups[0]!, rate: "0", treatment: "exempt", reasonCode: "health", evidence: { statementText: "Required <statement>" } }],
      },
      number: "AGR-1", locale: "da-DK", settings: settings as never, recipient: "buyer@example.test", url: "https://app.example.test/a/token",
    })
    for (const value of ["Frozen Seller", "Seller Street", "CVR-nr. 12345678", "Frozen Buyer", "2200 København N", "CVR-nr. 87654321", "Required &lt;statement&gt;", "Afrunding"]) expect(email.html).toContain(value)
    expect(email.html.match(/Frozen Buyer/g)).toHaveLength(1)
    expect(email.html).not.toContain("Required <statement>")
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
