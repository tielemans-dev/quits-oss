import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { PublicInvoicePaymentPage } from "../../components/invoices/public-invoice-payment-page"

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

describe("PublicInvoicePaymentPage", () => {
  it("renders a pay action while an invoice is unpaid", () => {
    const html = renderToStaticMarkup(
      <PublicInvoicePaymentPage
        token="signed-token"
        state={{
          kind: "ready",
          paymentState: "unpaid",
          invoice: baseInvoice,
          stripeEnabled: true,
        }}
      />
    )

    expect(html).toContain("Pay now")
    expect(html).toContain("INV-0001")
  })

  it("shows the balance due after a partial payment", () => {
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
          stripeEnabled: true,
        }}
      />
    )

    expect(html).toContain("Payment received")
    expect(html).not.toContain("Pay now")
  })

  it("shows an invoice credited in full as credited, with nothing to pay", () => {
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
      <PublicInvoicePaymentPage
        token="signed-token"
        state={{
          kind: "invalid",
        }}
      />
    )

    expect(html).toContain("This invoice payment link is invalid or has expired.")
  })
})
