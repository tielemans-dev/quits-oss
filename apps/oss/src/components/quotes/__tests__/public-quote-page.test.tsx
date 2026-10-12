// @vitest-environment jsdom

import type { ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { LocalizedDocument } from "../../documents/localized-document"
import { PublicQuotePage } from "../public-quote-page"

// MOCK: synthetic quote, financial amounts and identities for rendering tests only.
const baseQuote = {
  id: "quote-1",
  number: "QTE-0001",
  status: "sent",
  issueDate: new Date("2026-03-01T00:00:00.000Z"),
  expiryDate: new Date("2026-03-15T00:00:00.000Z"),
  totalGross: { toNumber: () => 1250 },
  totalTax: { toNumber: () => 250 },
  subtotalNet: { toNumber: () => 1000 },
  vatRows: [{ ratePercent: "25", net: "1000.00", tax: "250.00", gross: "1250.00" }],
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
  it.each([
    ["en-US", "Subtotal excl. tax", "Tax (25%)", "Total incl. tax"],
    ["da-DK", "Subtotal ekskl. moms", "Moms (25 %)", "Total inkl. moms"],
  ])("shows stored VAT totals in %s", (locale, subtotal, tax, total) => {
    const html = page(locale, <PublicQuotePage token="signed-token" state={{
      kind: "ready", decisionState: "pending", seller, quote: { ...baseQuote, currency: "DKK" },
    }} />)
    expect(html).toContain(subtotal)
    expect(html).toContain(tax)
    expect(html).toContain(total)
    const container = document.createElement("div")
    container.innerHTML = html
    const amounts = Array.from(container.querySelectorAll('[data-slot="amount"]'))
    expect(amounts.map((amount) => amount.textContent)).toEqual(
      [1000, 250, 1250].map((value) => new Intl.NumberFormat(locale, {
        style: "currency", currency: "DKK",
      }).format(value))
    )
    expect(amounts.map((amount) => Array.from(amount.querySelectorAll(".tabular-nums"))
      .map((digits) => digits.textContent))).toEqual([
      ["1", "000", "00"], ["250", "00"], ["1", "250", "00"],
    ])
    for (const amount of amounts) {
      expect(amount.classList.contains("tabular-nums")).toBe(false)
      expect(amount.querySelector(".num, svg, [aria-hidden='true']")).toBeNull()
    }
  })

  it("omits VAT for a seller charging no VAT", () => {
    const html = page("da-DK", <PublicQuotePage token="signed-token" state={{
      kind: "ready", decisionState: "pending", seller,
      quote: { ...baseQuote, totalGross: 1000, totalTax: 0, subtotalNet: 1000,
        vatRows: [{ ratePercent: "0", net: "1000.00", tax: "0.00", gross: "1000.00" }] },
    }} />)
    expect(html).not.toContain("Moms (")
    expect(html).toContain("Total inkl. moms")
  })

  it("shows each stored VAT rate and rounding without deriving a rate from header totals", () => {
    const html = page("en-US", <PublicQuotePage token="signed-token" state={{
      kind: "ready", decisionState: "pending", seller,
      quote: { ...baseQuote, totalGross: 1200.01, totalTax: 200, rounding: "0.01",
        vatRows: [{ ratePercent: "25", net: "600.00", tax: "150.00", gross: "750.00" },
          { ratePercent: "12.5", net: "400.00", tax: "50.00", gross: "450.00" }] },
    }} />)
    expect(html).toContain("Tax 25% of $600.00")
    expect(html).toContain("Tax 12.5% of $400.00")
    expect(html).toContain("Rounding")
    const container = document.createElement("div")
    container.innerHTML = html
    expect(container.querySelectorAll('[data-slot="amount"]')[4]?.textContent).toBe("$1,200.01")
  })
  it("top-aligns content-sized cards, uses micro labels and right-aligned tabular amounts", () => {
    const html = page("en-US", <PublicQuotePage token="test" state={{ kind: "ready", decisionState: "pending", seller, quote: baseQuote }} />)
    expect(html).toContain("items-start")
    expect(html).not.toContain("flex-col justify-center")
    expect(html).toMatch(/<h2 class="text-xs font-medium uppercase tracking-wide text-muted-foreground"/)
    expect(html).toMatch(/<label class="text-xs font-medium uppercase tracking-wide text-muted-foreground"/)
    expect(html).toContain('class="text-right font-medium tabular-nums"')
  })
  it.each(["America/New_York", "Pacific/Pago_Pago", "Europe/Copenhagen"])(
    "preserves calendar dates while localizing the issue instant in %s", timezone => {
      const html = page("en-US", <PublicQuotePage token="signed-token" state={{
        kind: "ready", decisionState: "pending", seller,
        quote: { ...baseQuote, timezone },
      }} />)
      expect(html).toContain("15 Mar 2026")
      expect(html).not.toContain("14 Mar 2026")
      expect(html).toContain(timezone === "Europe/Copenhagen" ? "1 Mar 2026" : "28 Feb 2026")
    }
  )

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
    expect(html).toContain("15 Mar 2026")
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
    expect(html).toContain("You accepted the quote on 5 Mar 2026.")
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
      expect(html).toContain("Acceptér tilbud")
      expect(html).toContain("Afvis tilbud")
      expect(html).toContain("Noter")
      expect(html).toContain("1.250,00 kr.")
      expect(html).toContain("2\u00a0×\u00a0625,00 kr.")
      expect(html).toContain("1. mar. 2026")
      expect(html).toContain("15. mar. 2026")
      expect(html).toContain('lang="da-DK"')
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
      expect(accepted).toContain("Du accepterede tilbuddet den 5. mar. 2026.")
      expect(accepted).not.toContain("Acceptér tilbud")
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
