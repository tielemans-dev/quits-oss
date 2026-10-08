import fixtureV2 from "../../../domain/agreements/__tests__/fixtures/offer-v2.json"
import { describe, expect, it } from "vitest"
import type { AgreementOfferSnapshot } from "@quits/contracts/agreements"
import { agreementOfferTotals } from "../offer-totals"
import { serializePublicAgreementSession } from "../public-session"

const snapshot = (overrides: Partial<AgreementOfferSnapshot> = {}): AgreementOfferSnapshot => ({
  title: "Hjemmeside",
  summary: null,
  sellerSnapshot: { companyName: "Frozen ApS" },
  buyerSnapshot: { name: "Kunde" },
  termsHtml: "<p>Vilkår</p>",
  validUntil: "2099-03-28T00:00:00.000Z",
  timezone: "Europe/Copenhagen",
  currency: "DKK",
  countryCode: "DK",
  locale: "da-DK",
  taxRegime: "eu_vat",
  taxRate: "25.00",
  pricesIncludeTax: false,
  dueInDays: 14,
  billingTrigger: "on_acceptance",
  subtotalNet: "1000.00",
  totalTax: "250.00",
  totalGross: "1250.00",
  deliverables: [],
  ...overrides,
})

const LARGE_LOGO = `data:image/png;base64,${"A".repeat(200_000)}`

function agreementSession(
  offer: AgreementOfferSnapshot,
  settings: Record<string, string | null> = {},
  scope: "decide" | "read" | "sign_off" = "decide",
) {
  return {
    agreement: {
      number: "AGR-1",
      title: "Hjemmeside",
      status: "sent",
      offerRevision: 1,
      issueDate: null,
      expiresAt: null,
      acceptedAt: null,
      declinedAt: null,
      declineReason: null,
      offerSnapshot: offer,
      deliverables: [
        {
          id: "line-1",
          sortOrder: 0,
          title: "Design",
          description: "Layout",
          status: "delivered",
          deliveryRevision: 1,
          deliveredAt: null,
          acceptedAt: null,
          acceptedRevision: null,
          changeRequestNote: null,
          agreedDate: null,
          expectedDate: null,
        },
      ],
      organization: {
        settings: {
          locale: "en-US",
          timezone: "UTC",
          companyName: "Renamed ApS",
          companyLogo: null,
          ...settings,
        },
      },
    },
    payload: scope === "sign_off" ? { scope, deliverableId: "line-1" } : { scope },
  } as never
}

describe("serializePublicAgreementSession", () => {
  it("presents the agreement in the offer's own language and with the seller's identity", () => {
    const page = serializePublicAgreementSession(agreementSession(snapshot()), "tok.en")

    expect(page.kind).toBe("ready")
    expect(page.locale).toBe("da-DK")
    expect(page.seller).toEqual({ name: "Frozen ApS", logo: null })
  })

  it("falls back to the organization's language when the stored one is malformed", () => {
    const page = serializePublicAgreementSession(
      agreementSession(snapshot({ locale: "not a locale!" }), { locale: "da-DK" }),
      "tok.en",
    )

    // A malformed tag would make every Intl formatter on the page throw.
    expect(page.locale).toBe("da-DK")
    expect(() => new Intl.NumberFormat(page.locale)).not.toThrow()
  })

  it("falls back to US English when neither the offer nor the organization has a usable language", () => {
    const page = serializePublicAgreementSession(
      agreementSession(snapshot({ locale: "" }), { locale: "!!" }),
      "tok.en",
    )

    expect(page.locale).toBe("en-US")
  })

  it("names the seller from the organization when the offer froze none", () => {
    const page = serializePublicAgreementSession(
      agreementSession(snapshot({ sellerSnapshot: null })),
      "tok.en",
    )

    expect(page.seller.name).toBe("Renamed ApS")
  })

  it("serves an uploaded logo from the logo route, never inside the page data", () => {
    const decide = serializePublicAgreementSession(
      agreementSession(snapshot(), { companyLogo: LARGE_LOGO }),
      "tok.en",
    )
    const signOff = serializePublicAgreementSession(
      agreementSession(snapshot(), { companyLogo: LARGE_LOGO }, "sign_off"),
      "tok.en",
    )

    expect(decide.seller.logo).toBe("/a/tok.en/logo")
    expect(signOff.seller.logo).toBe("/a/tok.en/logo")
    expect(JSON.stringify(decide)).not.toContain("data:image")
    expect(JSON.stringify(signOff)).not.toContain("data:image")
  })

  it("passes an http(s) logo on as it is", () => {
    const page = serializePublicAgreementSession(
      agreementSession(snapshot(), { companyLogo: "https://acme.example/logo.png" }),
      "tok.en",
    )

    expect(page.seller.logo).toBe("https://acme.example/logo.png")
  })

  it("returns the language and seller for a delivery link, whose delivery carries no language of its own", () => {
    const page = serializePublicAgreementSession(
      agreementSession(snapshot({ locale: "not a locale!" }), { locale: "da-DK" }, "sign_off"),
      "tok.en",
    )

    expect(page).toMatchObject({ scope: "sign_off", locale: "da-DK", seller: { name: "Frozen ApS" } })
    expect(page.kind === "ready" && page.scope === "sign_off" && "locale" in page.deliverable).toBe(false)
  })
})

describe("agreementOfferTotals", () => {
  const v2 = fixtureV2.snapshot as unknown as AgreementOfferSnapshot

  it("reads a v2 offer's own service total, with its payable rounding", () => {
    expect(agreementOfferTotals(v2)).toMatchObject({
      isV2: true,
      net: "0.02",
      tax: "0.01",
      gross: "0.02",
      payableRounding: "-0.01",
    })
  })

  it("reads the flat totals of an older offer", () => {
    expect(agreementOfferTotals(snapshot())).toEqual({
      isV2: false,
      net: "1000.00",
      tax: "250.00",
      gross: "1250.00",
      payableRounding: null,
    })
  })
})
