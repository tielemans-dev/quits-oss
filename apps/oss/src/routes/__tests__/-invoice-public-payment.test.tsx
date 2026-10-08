import type { ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { PublicInvoicePaymentPage } from "../../components/invoices/public-invoice-payment-page"
import { LocalizedDocument } from "../../components/documents/localized-document"

const tinyLogoDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

const baseInvoice = {
  id: "invoice-1",
  number: "INV-0001",
  status: "sent",
  paymentStatus: "unpaid",
  issueDate: new Date("2026-03-01T00:00:00.000Z"),
  dueDate: new Date("2026-03-15T00:00:00.000Z"),
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
}

const seller = { name: "Acme Studio", logo: null }

function page(locale: string, children: ReactNode) {
  return renderToStaticMarkup(<LocalizedDocument locale={locale}>{children}</LocalizedDocument>)
}

describe("PublicInvoicePaymentPage", () => {
  it("renders a pay action while an invoice is unpaid", () => {
    const html = page(
      "en-US",
      <PublicInvoicePaymentPage
        token="signed-token"
        state={{
          kind: "ready",
          paymentState: "unpaid",
          invoice: baseInvoice,
          seller,
          stripeEnabled: true,
        }}
      />
    )

    expect(html).toContain("Pay now")
    expect(html).toContain("INV-0001")
    expect(html).toContain("Invoice from Acme Studio")
    expect(html).toContain("$1,250.00")
    expect(html).toContain("Mar 1, 2026")
    expect(html).toContain("Mar 15, 2026")
    expect(html).toContain('lang="en"')
  })

  it("shows the balance due after a partial payment", () => {
    const html = page(
      "en-US",
      <PublicInvoicePaymentPage
        token="signed-token"
        state={{
          kind: "ready",
          paymentState: "unpaid",
          invoice: {
            ...baseInvoice,
            paymentStatus: "partially_paid",
            amountPaid: 500,
            amountCredited: 0,
            balanceDue: 750,
          },
          seller,
          stripeEnabled: true,
        }}
      />
    )

    expect(html).toContain("Partially paid")
    expect(html).toContain("Balance due")
    expect(html).toContain("$750.00")
    expect(html).toContain("Pay now")
  })

  it("renders a read-only confirmation once an invoice is paid", () => {
    const html = page(
      "en-US",
      <PublicInvoicePaymentPage
        token="signed-token"
        state={{
          kind: "ready",
          paymentState: "paid",
          invoice: {
            ...baseInvoice,
            status: "paid",
            paymentStatus: "paid",
          },
          seller,
          stripeEnabled: true,
        }}
      />
    )

    expect(html).toContain("Payment received")
    expect(html).not.toContain("Pay now")
  })

  it("shows an invoice credited in full as credited, with nothing to pay", () => {
    const html = page(
      "en-US",
      <PublicInvoicePaymentPage
        token="signed-token"
        state={{
          kind: "ready",
          paymentState: "paid",
          invoice: {
            ...baseInvoice,
            status: "credited",
            paymentStatus: "unpaid",
            amountPaid: 0,
            amountCredited: 1250,
            balanceDue: 0,
          },
          seller,
          stripeEnabled: true,
        }}
      />
    )

    expect(html).toContain("Invoice credited")
    expect(html).toContain("Credited")
    expect(html).toContain("$0.00")
    expect(html).not.toContain("Payment received")
    expect(html).not.toContain("Pay now")
  })

  it("renders an invalid-link state", () => {
    const html = page(
      "en-US",
      <PublicInvoicePaymentPage
        token="signed-token"
        state={{
          kind: "invalid",
        }}
      />
    )

    expect(html).toContain("This invoice payment link is invalid or has expired.")
  })

  describe("in Danish", () => {
    const danishInvoice = { ...baseInvoice, currency: "DKK", timezone: "Europe/Copenhagen" }

    it("shows Danish labels and da-DK money and dates", () => {
      const html = page(
        "da-DK",
        <PublicInvoicePaymentPage
          token="signed-token"
          state={{
            kind: "ready",
            paymentState: "unpaid",
            invoice: danishInvoice,
            seller,
            stripeEnabled: true,
          }}
        />
      )

      expect(html).toContain("Faktura fra Acme Studio")
      expect(html).toContain("Betal denne faktura")
      expect(html).toContain("Betal nu")
      expect(html).toContain("Afventer betaling")
      expect(html).toContain("Fakturaoversigt")
      expect(html).toContain("Fakturadato")
      expect(html).toContain("Forfaldsdato")
      expect(html).toContain("Til betaling")
      expect(html).toContain("Kunde")
      expect(html).toContain("Virksomhed")
      expect(html).toContain("1.250,00 kr.")
      expect(html).toContain("2\u00a0×\u00a0625,00 kr.")
      expect(html).toContain("1. mar. 2026")
      expect(html).toContain("15. mar. 2026")
      expect(html).toContain('lang="da"')
      expect(html).not.toContain("Pay now")
      expect(html).not.toContain("Invoice from")
      expect(html).not.toContain("$")
    })

    it("shows the settled and credited states in Danish", () => {
      const paid = page(
        "da-DK",
        <PublicInvoicePaymentPage
          token="signed-token"
          state={{
            kind: "ready",
            paymentState: "paid",
            invoice: { ...danishInvoice, status: "paid", paymentStatus: "paid" },
            seller,
            stripeEnabled: true,
          }}
        />
      )
      const credited = page(
        "da-DK",
        <PublicInvoicePaymentPage
          token="signed-token"
          state={{
            kind: "ready",
            paymentState: "paid",
            invoice: {
              ...danishInvoice,
              status: "credited",
              amountCredited: 1250,
              balanceDue: 0,
            },
            seller,
            stripeEnabled: true,
          }}
        />
      )

      expect(paid).toContain("Betaling modtaget")
      expect(paid).toContain("Denne faktura er allerede betalt.")
      expect(credited).toContain("Faktura krediteret")
      expect(credited).toContain("Denne faktura er krediteret fuldt ud. Der er intet at betale.")
      expect(credited).toContain("0,00 kr.")
    })

    it("shows the partial payment and the offline notice in Danish", () => {
      const partial = page(
        "da-DK",
        <PublicInvoicePaymentPage
          token="signed-token"
          state={{
            kind: "ready",
            paymentState: "unpaid",
            invoice: { ...danishInvoice, amountPaid: 500, amountCredited: 0, balanceDue: 750 },
            seller,
            stripeEnabled: false,
          }}
        />
      )

      expect(partial).toContain("Delvist betalt")
      expect(partial).toContain("Betalt")
      expect(partial).toContain("750,00 kr.")
      expect(partial).toContain("Onlinebetaling er ikke tilgængelig for denne faktura.")
    })

    it("shows the invalid-link state in Danish", () => {
      const html = page(
        "da-DK",
        <PublicInvoicePaymentPage token="signed-token" state={{ kind: "invalid" }} />
      )

      expect(html).toContain("Fakturaen er ikke tilgængelig")
      expect(html).toContain("Dette betalingslink er ugyldigt eller udløbet.")
    })

    it("formats a decimal quantity with the Danish decimal comma", () => {
      const html = page(
        "da-DK",
        <PublicInvoicePaymentPage
          token="signed-token"
          state={{
            kind: "ready",
            paymentState: "unpaid",
            invoice: {
              ...danishInvoice,
              items: [{ ...danishInvoice.items[0]!, quantity: { toNumber: () => 1.5 } }],
            },
            seller,
            stripeEnabled: true,
          }}
        />
      )

      expect(html).toContain("1,5\u00a0×\u00a0625,00 kr.")
    })
  })

  describe("seller identity", () => {
    const ready = (sellerValue: { name: string | null; logo: string | null }) => ({
      kind: "ready" as const,
      paymentState: "unpaid" as const,
      invoice: baseInvoice,
      seller: sellerValue,
      stripeEnabled: true,
    })

    it("shows the seller's logo and name at the top", () => {
      const html = page(
        "en-US",
        <PublicInvoicePaymentPage
          token="signed-token"
          state={ready({ name: "Acme Studio", logo: tinyLogoDataUrl })}
        />
      )

      expect(html).toContain(`src="${tinyLogoDataUrl}"`)
      expect(html).toContain('referrerPolicy="no-referrer"')
      expect(html.indexOf("<header")).toBeLessThan(html.indexOf("INV-0001"))
    })

    it("never falls back to the product name when the seller has no name", () => {
      const html = page(
        "en-US",
        <PublicInvoicePaymentPage token="signed-token" state={ready({ name: null, logo: null })} />
      )

      expect(html).not.toContain("Quits")
      expect(html).not.toContain("<header")
      expect(html).not.toContain("Invoice from")
    })

    it("describes the logo when there is no name beside it", () => {
      const html = page(
        "da-DK",
        <PublicInvoicePaymentPage
          token="signed-token"
          state={ready({ name: null, logo: tinyLogoDataUrl })}
        />
      )

      expect(html).toContain('alt="Virksomhedslogo"')
    })
  })
})
