// @vitest-environment jsdom

// MOCK: synthetic quote data only. Rendering uses the real public component.
import { nonVatStatement } from "../../../lib/documents/non-vat-note"
import { translate } from "../../../lib/i18n/translate"
import { formatCurrency } from "../../../lib/i18n/format"
import type { ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { LocalizedDocument } from "../../documents/localized-document"
import { PublicQuotePage } from "../public-quote-page"
import { Prisma } from "../../../../generated/prisma/client"
import { composeQuoteEmail } from "../../../domain/documents/quote-email"
import { QuotePdfDocument } from "../../../lib/quote-pdf"
import { isValidElement } from "react"
import { Text } from "@react-pdf/renderer"
import { lineDisplayForUi } from "../../../trpc/routers/document-display"
import { lineColumnKeys, priceBasis } from "../../../lib/documents/line-amounts"
import { priceDocumentV2 } from "../../../domain/documents/pricing"
import { serializePublicQuoteSession } from "../../../lib/quotes/public-session"

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
      unitPriceNet: { toNumber: () => 500 },
      lineNet: { toNumber: () => 1000 },
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

function pdfText(node: ReactNode): string[] {
  if (Array.isArray(node)) return node.flatMap(pdfText)
  if (isValidElement<{ children?: ReactNode }>(node)) {
    const children = pdfText(node.props.children)
    return node.type === Text ? [children.join("")] : children
  }
  return typeof node === "string" || typeof node === "number" ? [String(node)] : []
}

describe("PublicQuotePage", () => {
  it.each([false, true])("agrees with app, email and PDF for pricesIncludeTax=%s in DA/EN", pricesIncludeTax => {
    const D = Prisma.Decimal
    for (const locale of ["da-DK", "en-US"]) {
      const quote = { ...baseQuote, pricesIncludeTax, locale, currency: "DKK", organization: { settings: {} },
        subtotalNet: new D(22500), totalTax: new D(5625), totalGross: new D(28125),
        vatRows: [{ ratePercent: "25", net: "22500.00", tax: "5625.00", gross: "28125.00" }],
        items: [18000, 4500].map((net, index) => ({
          id: String(index), description: `Service ${index}`, quantity: new D(1), sortOrder: index,
          unitPriceNet: new D(net), lineNet: new D(net), unitPriceGross: new D(net).mul("1.25"),
          lineGross: new D(net).mul("1.25"), lineTax: new D(net).mul("0.25"), taxRate: new D(25),
          vatTreatment: "standard", vatCountry: "DK", vatReasonCode: null, vatRateInput: "0.25",
        })),
      }
      const email = composeQuoteEmail({ quote, settings: { companyName: "Synthetic seller" } as never,
        to: "buyer@example.test", publicQuoteUrl: null }).message.html ?? ""
      const pdf = pdfText(QuotePdfDocument({ quote: quote as unknown as Parameters<typeof QuotePdfDocument>[0]["quote"] })).join(" ")
      const normalize = (text: string) => text.replace(/[  ]/g, " ")
      const columns = lineColumnKeys(priceBasis(pricesIncludeTax))
      for (const decisionState of ["pending", "accepted"] as const) {
        const session = serializePublicQuoteSession({ quote, decisionState }, "synthetic")
        const container = document.createElement("div")
        container.innerHTML = page(locale, <PublicQuotePage token="synthetic" state={{ kind: "ready", ...session }} />)
        const lines = Array.from(container.querySelectorAll("h2")).find(heading => heading.textContent === translate("public.quote.summary", locale))!.nextElementSibling!
        for (const [index, item] of quote.items.entries()) {
          const app = lineDisplayForUi(quote, item)
          for (const amount of [app.displayUnitPrice, app.displayAmount]) {
            const formatted = normalize(formatCurrency(amount, "DKK", locale))
            expect(normalize(lines.children[index]!.textContent!)).toContain(formatted)
            expect(normalize(email)).toContain(formatted)
            expect(normalize(pdf)).toContain(formatted)
          }
        }
        for (const key of [columns.unitPrice, columns.amount]) {
          const label = translate(key, locale)
          expect(lines.textContent).toContain(label)
          expect(email).toContain(label)
          expect(pdf).toContain(label)
        }
        expect(normalize(container.textContent!)).toContain(normalize(formatCurrency(28125, "DKK", locale)))
        expect(normalize(email)).toContain(normalize(formatCurrency(28125, "DKK", locale)))
        expect(normalize(pdf)).toContain(normalize(formatCurrency(28125, "DKK", locale)))
      }
    }
  })
  it.each([
    { name: "inclusive inputs", items: [{ description: "Brand identity", quantity: "1", unitPrice: "22500" }, { description: "Website design", quantity: "1", unitPrice: "5625" }], taxRate: "25" },
    { name: "zero tax", items: [{ description: "No tax", quantity: "2", unitPrice: "100" }], taxRate: "0" },
    { name: "mixed rates and allocated rounding", items: [
      { description: "Tiny taxed line", quantity: "2", unitPrice: "0.01", vat: { treatment: "standard" as const, rate: "0.25" } },
      { description: "Reduced rate", quantity: "2", unitPrice: "100", vat: { treatment: "standard" as const, rate: "0.125" } },
      { description: "Zero rate", quantity: "1", unitPrice: "100", vat: { treatment: "unclassified_zero" as const, rate: "0" } },
    ], taxRate: "25" },
  ])("uses stored gross values from $name without repricing", ({ items, taxRate }) => {
    const priced = priceDocumentV2({ items, taxRate, pricesIncludeTax: true, currency: "DKK" })
    const quote = { ...baseQuote, currency: "DKK", pricesIncludeTax: true,
      vatRows: priced.calculation.groups.map(group => ({ ratePercent: String(Number(group.rate) * 100), net: group.net, tax: group.tax, gross: group.gross })),
      rounding: priced.calculation.payableRounding,
      items: priced.itemRows.map((row, index) => ({ ...row, id: String(index),
        quantity: Number(row.quantity), unitPriceNet: Number(row.unitPriceNet), unitPriceGross: Number(row.unitPriceGross),
        lineNet: Number(row.lineNet), lineGross: Number(row.lineGross), taxRate: Number(row.taxRate),
      })), subtotalNet: Number(priced.subtotalNet), totalTax: Number(priced.totalTax), totalGross: Number(priced.totalGross),
    }
    const money = (value: number) => new Intl.NumberFormat("da-DK", { style: "currency", currency: "DKK" }).format(value)
    for (const decisionState of ["pending", "accepted"] as const) {
      const session = serializePublicQuoteSession({ quote, decisionState }, "test")
      const html = page("da-DK", <PublicQuotePage token="test" state={{ kind: "ready", ...session }} />)
      const container = document.createElement("div")
      container.innerHTML = html
      const lines = Array.from(container.querySelectorAll("h2")).find(heading => heading.textContent === translate("public.quote.summary", "da-DK"))!.nextElementSibling!
      for (const [index, row] of quote.items.entries()) {
        expect(lines.children[index]?.textContent).toContain(money(row.unitPriceGross))
        expect(lines.children[index]?.textContent).toContain(money(row.lineGross))
        expect(session.quote.items[index]).toMatchObject({ unitPriceNet: row.unitPriceNet, lineNet: row.lineNet })
      }
      expect(session.quote.totalGross).toBe(Number(priced.totalGross))
      expect(Array.from(container.querySelectorAll('[data-slot="amount"]')).at(-1)?.textContent).toBe(money(Number(priced.totalGross)))
    }
    if (items[0]?.description === "Brand identity") {
      expect(quote.items.map(row => row.lineNet)).toEqual([18000, 4500])
      expect(quote.totalGross).toBe(28125)
    }
  })

  it.each(["en-US", "da-DK"])("shows net lines and unit prices before and after acceptance in %s", locale => {
    const quote = {
      ...baseQuote, currency: "DKK", subtotalNet: 22500, totalTax: 5625, totalGross: 28125,
      vatRows: [{ ratePercent: "25", net: "22500.00", tax: "5625.00", gross: "28125.00" }],
      items: [
        { id: "brand", description: "Brand identity", quantity: 1, unitPriceNet: 18000, lineNet: 18000, unitPriceGross: 22500, lineGross: 22500, sortOrder: 0 },
        { id: "web", description: "Website design", quantity: 1, unitPriceNet: 4500, lineNet: 4500, unitPriceGross: 5625, lineGross: 5625, sortOrder: 1 },
      ],
    }
    const money = (value: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "DKK" }).format(value)
    for (const decisionState of ["pending", "accepted"] as const) {
      const html = page(locale, <PublicQuotePage token="test" state={{ kind: "ready", decisionState, seller, quote }} />)
      const container = document.createElement("div")
      container.innerHTML = html
      const lines = Array.from(container.querySelectorAll("h2")).find(heading => heading.textContent === translate("public.quote.summary", locale))!.nextElementSibling!
      expect(lines.textContent).toContain(money(18000))
      expect(lines.textContent).toContain(money(4500))
      expect(lines.textContent).not.toContain(money(22500))
      expect(lines.textContent).not.toContain(money(5625))
      expect(lines.textContent).toContain(locale === "da-DK" ? "Enhedspris ekskl. moms" : "Unit Price excl. tax")
      expect(lines.textContent).toContain(locale === "da-DK" ? "Beløb ekskl. moms" : "Amount excl. tax")
      expect(container.querySelectorAll('[data-slot="amount"]')[2]?.textContent).toBe(money(28125))
    }
  })

  it.each([
    ["en-US", "Subtotal excl. tax", "Tax 25%", "Total incl. tax"],
    ["da-DK", "Subtotal ekskl. moms", "Moms 25 %", "Total inkl. moms"],
  ])("shows stored VAT totals in %s", (locale, subtotal, tax, total) => {
    const html = page(locale, <PublicQuotePage token="signed-token" state={{
      kind: "ready", decisionState: "pending", seller, quote: { ...baseQuote, currency: "DKK" },
    }} />)
    expect(html).toContain("Main Street 1")
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
    expect(html).toContain("Total")
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
  it("shows the frozen buyer identity with its tax IDs, not the edited contact", () => {
    const html = page("en-US", <PublicQuotePage token="signed-token" state={{
      kind: "ready", decisionState: "pending", seller,
      quote: { ...baseQuote, contact: { name: "Renamed Contact", email: null, company: "Renamed Co" },
        buyerSnapshot: { name: "Issued Buyer", company: "Issued Buyer ApS", country: "DK", taxIds: [{ scheme: "cvr", value: "87654321", countryCode: "DK" }] } },
    }} />)
    expect(html).toContain("Issued Buyer ApS")
    expect(html).toContain("87654321")
    expect(html).not.toContain("Renamed")
  })
  it("keeps the seller's tax IDs out of the customer card", () => {
    const html = page("en-US", <PublicQuotePage token="signed-token" state={{
      kind: "ready", decisionState: "pending", seller,
      quote: { ...baseQuote,
        sellerSnapshot: { ...baseQuote.sellerSnapshot, taxIds: [{ scheme: "cvr", value: "12345678", countryCode: "DK" }] },
        buyerSnapshot: { ...baseQuote.buyerSnapshot, country: "DK", taxIds: [{ scheme: "cvr", value: "87654321", countryCode: "DK" }] } },
    }} />)
    const container = document.createElement("div")
    container.innerHTML = html
    const customerCard = [...container.querySelectorAll("div.rounded-lg.border")].find(card => card.textContent?.includes("Buyer Name"))!
    expect(customerCard.textContent).toContain("87654321")
    expect(customerCard.textContent).not.toContain("12345678")
    expect(container.textContent).toContain("12345678")
  })
  it("top-aligns content-sized cards, uses micro labels and right-aligned tabular amounts", () => {
    const html = page("en-US", <PublicQuotePage token="test" state={{ kind: "ready", decisionState: "pending", seller, quote: baseQuote }} />)
    expect(html).toContain("items-start")
    expect(html).not.toContain("flex-col justify-center")
    expect(html).toMatch(/<h2 class="text-xs font-medium uppercase tracking-wide text-muted-foreground"/)
    expect(html).toMatch(/<label class="text-xs font-medium uppercase tracking-wide text-muted-foreground"/)
    expect(html).toContain('class="text-right font-medium tabular-nums"')
  })
  it.each(["da-DK", "en-US"])("renders frozen non-registration once with stored line rates and totals in %s", locale => {
    for (const taxRate of [0, 25]) {
      const html = page(locale, <PublicQuotePage token="synthetic" state={{ kind: "ready", decisionState: "pending", seller,
        quote: { ...baseQuote, sellerSnapshot: { ...baseQuote.sellerSnapshot, momsRegistered: false },
          notes: `Synthetic instructions\n${nonVatStatement("da")}\n${nonVatStatement("en")}`,
          items: baseQuote.items.map(item => ({ ...item, taxRate })) },
      }} />)
      expect(html.split(nonVatStatement(locale))).toHaveLength(2)
      expect(html).toContain("Synthetic instructions")
      expect(html).toContain(formatCurrency(1250, "USD", locale))
      if (taxRate === 0) expect(html).toContain(translate("line.noVat", locale))
      else { expect(html).toContain("25 % moms"); expect(html).not.toContain(translate("line.noVat", locale)) }
    }
  })
  it.each([null, undefined, true])("does not infer non-registration for legacy/registered quotes %s", momsRegistered => {
    const html = page("en-US", <PublicQuotePage token="synthetic" state={{ kind: "ready", decisionState: "pending", seller,
      quote: { ...baseQuote, sellerSnapshot: { ...baseQuote.sellerSnapshot, momsRegistered }, items: baseQuote.items.map(item => ({ ...item, taxRate: 0 })) },
    }} />)
    expect(html).not.toContain(nonVatStatement("en"))
    expect(html).not.toContain("No moms")
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
      expect(html).toContain("2\u00a0×\u00a0500,00 kr.")
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
