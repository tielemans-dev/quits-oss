import type { ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { LocalizedDocument } from "../../documents/localized-document"
import { PublicQuotePage } from "../public-quote-page"

const baseQuote = {
  id: "quote-1",
  number: "QTE-0001",
  status: "sent",
  issueDate: new Date("2026-03-01T00:00:00.000Z"),
  expiryDate: new Date("2026-03-15T00:00:00.000Z"),
  totalGross: { toNumber: () => 1250 },
  totalTax: { toNumber: () => 250 },
  subtotalNet: { toNumber: () => 1000 },
  currency: "USD",
  timezone: "UTC",
  notes: "Net 14",
  sellerSnapshot: {
    companyName: "Acme Studio",
    companyEmail: "billing@acme.example",
    companyAddress: "Main Street 1",
  },
  buyerSnapshot: {
    name: "Buyer Name",
    email: "buyer@example.com",
    company: "Buyer Co",
  },
  publicDecisionAt: null,
  publicRejectionReason: null,
  contact: {
    name: "Buyer Name",
    email: "buyer@example.com",
    company: "Buyer Co",
  },
  items: [
    {
      id: "item-1",
      description: "Consulting",
      quantity: { toNumber: () => 2 },
      unitPriceGross: { toNumber: () => 625 },
      lineGross: { toNumber: () => 1250 },
      sortOrder: 0,
    },
  ],
  invoices: [],
}

const seller = { name: "Acme Studio", logo: null }
const tinyLogoDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

function page(locale: string, children: ReactNode) {
  return renderToStaticMarkup(<LocalizedDocument locale={locale}>{children}</LocalizedDocument>)
}

describe("PublicQuotePage", () => {
  it("renders accept and reject actions while decision is pending", () => {
    const html = page(
      "en-US",
      <PublicQuotePage
        token="signed-token"
        state={{
          kind: "ready",
          decisionState: "pending",
          seller,
          quote: baseQuote,
        }}
      />
    )

    expect(html).toContain("Accept quote")
    expect(html).toContain("Reject quote")
    expect(html).toContain("QTE-0001")
    expect(html).toContain("Quote from Acme Studio")
    expect(html).toContain("$1,250.00")
    expect(html).toContain("Mar 15, 2026")
  })

  it("renders a read-only accepted state after acceptance", () => {
    const html = page(
      "en-US",
      <PublicQuotePage
        token="signed-token"
        state={{
          kind: "ready",
          decisionState: "accepted",
          seller,
          quote: {
            ...baseQuote,
            status: "accepted",
            publicDecisionAt: new Date("2026-03-05T12:00:00.000Z"),
          },
        }}
      />
    )

    expect(html).toContain("Quote accepted")
    expect(html).toContain("Decision recorded on Mar 5, 2026.")
    expect(html).not.toContain("Accept quote")
    expect(html).not.toContain("Reject quote")
  })

  it("renders a generic invalid-link state", () => {
    const html = page(
      "en-US",
      <PublicQuotePage
        token="signed-token"
        state={{
          kind: "invalid",
        }}
      />
    )

    expect(html).toContain("This quote link is invalid or has expired.")
  })

  describe("in Danish", () => {
    const danishQuote = { ...baseQuote, currency: "DKK", timezone: "Europe/Copenhagen" }

    it("shows Danish labels, actions and da-DK money and dates while pending", () => {
      const html = page(
        "da-DK",
        <PublicQuotePage
          token="signed-token"
          state={{ kind: "ready", decisionState: "pending", seller, quote: danishQuote }}
        />
      )

      expect(html).toContain("Tilbud fra Acme Studio")
      expect(html).toContain("Afventer svar")
      expect(html).toContain("Tilbudsdato")
      expect(html).toContain("Gyldigt til")
      expect(html).toContain("Tilbudsoversigt")
      expect(html).toContain("Gennemgå dette tilbud")
      expect(html).toContain("Årsag til afvisning (valgfri)")
      expect(html).toContain("Fortæl afsenderen, hvorfor tilbuddet ikke passer til dig.")
      expect(html).toContain("Accepter tilbud")
      expect(html).toContain("Afvis tilbud")
      expect(html).toContain("Noter")
      expect(html).toContain("1.250,00 kr.")
      expect(html).toContain("2 x 625,00 kr.")
      expect(html).toContain("1. mar. 2026")
      expect(html).toContain("15. mar. 2026")
      expect(html).toContain('lang="da"')
      expect(html).not.toContain("Accept quote")
      expect(html).not.toContain("$")
    })

    it("shows the recorded decision in Danish", () => {
      const accepted = page(
        "da-DK",
        <PublicQuotePage
          token="signed-token"
          state={{
            kind: "ready",
            decisionState: "accepted",
            seller,
            quote: { ...danishQuote, publicDecisionAt: new Date("2026-03-05T12:00:00.000Z") },
          }}
        />
      )
      const rejected = page(
        "da-DK",
        <PublicQuotePage
          token="signed-token"
          state={{
            kind: "ready",
            decisionState: "rejected",
            seller,
            quote: {
              ...danishQuote,
              publicDecisionAt: new Date("2026-03-05T12:00:00.000Z"),
              publicRejectionReason: "For dyrt",
            },
          }}
        />
      )

      expect(accepted).toContain("Tilbud accepteret")
      expect(accepted).toContain("Accepteret")
      expect(accepted).toContain("Dit svar blev registreret den 5. mar. 2026.")
      expect(accepted).not.toContain("Accepter tilbud")
      expect(rejected).toContain("Tilbud afvist")
      expect(rejected).toContain("Afvist")
      expect(rejected).toContain("Årsag til afvisning")
      expect(rejected).toContain("For dyrt")
    })

    it("shows the invalid-link state in Danish", () => {
      const html = page("da-DK", <PublicQuotePage token="signed-token" state={{ kind: "invalid" }} />)

      expect(html).toContain("Tilbuddet er ikke tilgængeligt")
      expect(html).toContain("Dette tilbudslink er ugyldigt eller udløbet.")
    })
  })

  describe("seller identity", () => {
    it("shows the seller's logo and name at the top", () => {
      const html = page(
        "en-US",
        <PublicQuotePage
          token="signed-token"
          state={{
            kind: "ready",
            decisionState: "pending",
            seller: { name: "Acme Studio", logo: tinyLogoDataUrl },
            quote: baseQuote,
          }}
        />
      )

      expect(html).toContain(`src="${tinyLogoDataUrl}"`)
      expect(html.indexOf("<header")).toBeLessThan(html.indexOf("QTE-0001"))
    })

    it("never falls back to the product name when the seller has no name", () => {
      const html = page(
        "en-US",
        <PublicQuotePage
          token="signed-token"
          state={{
            kind: "ready",
            decisionState: "pending",
            seller: { name: null, logo: null },
            quote: { ...baseQuote, sellerSnapshot: null },
          }}
        />
      )

      expect(html).not.toContain("Quits")
      expect(html).not.toContain("<header")
      expect(html).not.toContain("Quote from")
    })
  })
})
