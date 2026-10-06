import { describe, expect, it } from "vitest"
import {
  serializePublicInvoiceSession,
} from "../payments/public-session"
import {
  serializePublicQuoteSession,
} from "../quotes/public-session"

const decimal = (value: number) => ({
  toNumber: () => value,
})

describe("public session serialization", () => {
  it("serializes invoice sessions without leaking internal organization settings", () => {
    // The loaded row carries organization secrets; the serializer must drop them.
    const invoiceRow = {
        id: "invoice-1",
        number: "INV-0001",
        status: "sent",
        paymentStatus: "unpaid",
        issueDate: new Date("2026-03-09T00:00:00.000Z"),
        dueDate: new Date("2026-03-23T00:00:00.000Z"),
        totalGross: decimal(250),
        totalTax: decimal(0),
        subtotalNet: decimal(250),
        currency: "USD",
        notes: null,
        sellerSnapshot: {
          companyName: "E2E Org",
        },
        buyerSnapshot: {
          name: "Invoice Customer",
        },
        contact: {
          name: "Invoice Customer",
          email: "invoice@example.com",
          company: "Invoice Customer LLC",
        },
        items: [
          {
            id: "item-1",
            description: "Implementation sprint",
            quantity: decimal(1),
            unitPriceGross: decimal(250),
            lineGross: decimal(250),
            sortOrder: 0,
          },
        ],
        organization: {
          settings: {
            stripePublishableKey: "pk_test_123",
            stripeSecretKeyEnc: "secret",
            stripeWebhookSecretEnc: "webhook",
          },
        },
      }
    const session = serializePublicInvoiceSession({
      invoice: invoiceRow,
      paymentState: "unpaid",
      stripeEnabled: true,
    })

    expect(session.invoice.totalGross).toBe(250)
    expect(session.invoice.items[0]?.quantity).toBe(1)
    expect("organization" in session.invoice).toBe(false)
  })

  it("serializes quote sessions into plain numbers", () => {
    const session = serializePublicQuoteSession({
      quote: {
        id: "quote-1",
        number: "QTE-0001",
        status: "sent",
        issueDate: new Date("2026-03-09T00:00:00.000Z"),
        expiryDate: new Date("2026-03-23T00:00:00.000Z"),
        totalGross: decimal(100),
        totalTax: decimal(0),
        subtotalNet: decimal(100),
        currency: "USD",
        notes: null,
        sellerSnapshot: {
          companyName: "E2E Org",
        },
        buyerSnapshot: {
          name: "Quote Customer",
        },
        publicDecisionAt: null,
        publicRejectionReason: null,
        contact: {
          name: "Quote Customer",
          email: "quote@example.com",
          company: "Quote Customer LLC",
        },
        items: [
          {
            id: "item-1",
            description: "Strategy session",
            quantity: decimal(1),
            unitPriceGross: decimal(100),
            lineGross: decimal(100),
            sortOrder: 0,
          },
        ],
        invoices: [],
      },
      decisionState: "pending",
    })

    expect(session.quote.totalGross).toBe(100)
    expect(session.quote.items[0]?.lineGross).toBe(100)
  })
})
