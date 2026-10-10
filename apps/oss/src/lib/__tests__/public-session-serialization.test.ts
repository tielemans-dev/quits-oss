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
        amountPaid: decimal(100),
        amountCredited: decimal(50),
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
        locale: "en-US",
        timezone: "UTC",
        organization: {
          settings: {
            locale: "en-US",
            timezone: "UTC",
            companyName: "E2E Org",
            companyLogo: null,
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
    }, "tok.en")

    expect(session.invoice.totalGross).toBe(250)
    expect(session.invoice.balanceDue).toBe(100)
    expect(session.invoice.items[0]?.quantity).toBe(1)
    expect("organization" in session.invoice).toBe(false)
    // Nothing of the settings row reaches the page except what presents the seller.
    expect(JSON.stringify(session)).not.toMatch(/pk_test_123|secret|webhook/)
  })

  it("presents an invoice in its own language, timezone, and with the seller's identity", () => {
    const session = serializePublicInvoiceSession({
      invoice: {
        id: "invoice-1",
        number: "INV-0001",
        status: "sent",
        paymentStatus: "unpaid",
        issueDate: new Date("2026-03-09T00:00:00.000Z"),
        dueDate: new Date("2026-03-23T00:00:00.000Z"),
        totalGross: decimal(1250),
        amountPaid: decimal(0),
        amountCredited: decimal(0),
        totalTax: decimal(250),
        subtotalNet: decimal(1000),
        currency: "DKK",
        locale: "da-DK",
        timezone: "Europe/Copenhagen",
        notes: null,
        sellerSnapshot: { companyName: "Frozen Name ApS" },
        buyerSnapshot: { name: "Kunde" },
        contact: { name: "Kunde", email: null, company: null },
        items: [],
        organization: {
          settings: {
            // The organization has since switched to English: the document keeps its own language.
            locale: "en-US",
            timezone: "UTC",
            companyName: "Renamed Name ApS",
            companyLogo: "https://acme.example/logo.png",
          },
        },
      },
      paymentState: "unpaid",
      stripeEnabled: true,
    }, "tok.en")

    expect(session.locale).toBe("da-DK")
    expect(session.invoice.timezone).toBe("Europe/Copenhagen")
    expect(session.seller).toEqual({
      name: "Frozen Name ApS",
      logo: "https://acme.example/logo.png",
    })
  })

  it("presents an invoice without a stored language in the organization's, and never as Quits", () => {
    const session = serializePublicInvoiceSession({
      invoice: {
        id: "invoice-1",
        number: "INV-0001",
        status: "sent",
        paymentStatus: "unpaid",
        issueDate: new Date("2026-03-09T00:00:00.000Z"),
        dueDate: new Date("2026-03-23T00:00:00.000Z"),
        totalGross: decimal(100),
        amountPaid: decimal(0),
        amountCredited: decimal(0),
        totalTax: decimal(0),
        subtotalNet: decimal(100),
        currency: "DKK",
        locale: "",
        timezone: "",
        notes: null,
        sellerSnapshot: null,
        buyerSnapshot: null,
        contact: { name: "Kunde", email: null, company: null },
        items: [],
        organization: {
          settings: { locale: "da-DK", timezone: "Europe/Copenhagen", companyName: null, companyLogo: "javascript:alert(1)" },
        },
      },
      paymentState: "unpaid",
      stripeEnabled: false,
    }, "tok.en")

    expect(session.locale).toBe("da-DK")
    expect(session.invoice.timezone).toBe("Europe/Copenhagen")
    expect(session.seller).toEqual({ name: null, logo: null })
  })

  it("preserves the frozen bank account and payment note for the public payment page", () => {
    const session = serializePublicInvoiceSession({
      invoice: {
        id: "invoice-1",
        number: "INV-0001",
        status: "sent",
        paymentStatus: "unpaid",
        issueDate: new Date("2026-03-09T00:00:00.000Z"),
        dueDate: new Date("2026-03-23T00:00:00.000Z"),
        totalGross: decimal(250),
        amountPaid: decimal(0),
        amountCredited: decimal(0),
        totalTax: decimal(0),
        subtotalNet: decimal(250),
        currency: "DKK",
        notes: null,
        sellerSnapshot: {
          companyName: "E2E Org",
          companyEmail: "billing@e2e.test",
          taxIds: [{ scheme: "vat", value: "DK12345678", countryCode: "DK" }],
          bankAccount: {
            accountHolder: "E2E Org ApS",
            bankName: "Danske Bank",
            regNumber: "0040",
            accountNumber: "0440116243",
            iban: "DK5000400440116243",
            bic: "DABADKKK",
          },
          paymentNote: "MobilePay Box 12345",
        },
        buyerSnapshot: { name: "Invoice Customer" },
        contact: { name: "Invoice Customer", email: "invoice@example.com", company: null },
        items: [],
      },
      paymentState: "unpaid",
      stripeEnabled: false,
    }, "tok.en")

    expect(session.invoice.sellerSnapshot?.taxIds).toEqual([{ scheme: "vat", value: "DK12345678", countryCode: "DK" }])
    expect(session.invoice.sellerSnapshot?.bankAccount?.iban).toBe("DK5000400440116243")
    expect(session.invoice.sellerSnapshot?.paymentNote).toBe("MobilePay Box 12345")
    expect(session.invoice.paymentReference).toBe("INV-0001")
  })

  it("serializes a missing or malformed seller snapshot as null", () => {
    const base = {
      id: "invoice-1",
      number: "INV-0001",
      status: "sent",
      paymentStatus: "unpaid",
      issueDate: "2026-03-09T00:00:00.000Z",
      dueDate: "2026-03-23T00:00:00.000Z",
      totalGross: 10,
      amountPaid: 0,
      amountCredited: 0,
      totalTax: 0,
      subtotalNet: 10,
      currency: "DKK",
      notes: null,
      buyerSnapshot: null,
      contact: { name: "Customer", email: null, company: null },
      items: [],
    }
    for (const sellerSnapshot of [null, "nonsense"]) {
      const session = serializePublicInvoiceSession({
        invoice: { ...base, sellerSnapshot },
        paymentState: "unpaid",
        stripeEnabled: false,
      }, "tok.en")
      expect(session.invoice.sellerSnapshot).toBeNull()
    }
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
        locale: "en-US",
        timezone: "UTC",
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
    }, "tok.en")

    expect(session.quote.totalGross).toBe(100)
    expect(session.quote.items[0]?.lineGross).toBe(100)
    expect(session.locale).toBe("en-US")
    expect(session.seller).toEqual({ name: "E2E Org", logo: null })
  })

  it("presents a quote in its own language with the seller's logo", () => {
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
        currency: "DKK",
        locale: "da-DK",
        timezone: "Europe/Copenhagen",
        notes: null,
        sellerSnapshot: { companyName: "Frozen Name ApS" },
        buyerSnapshot: null,
        publicDecisionAt: null,
        publicRejectionReason: null,
        contact: { name: "Kunde", email: null, company: null },
        items: [],
        invoices: [],
        organization: {
          settings: {
            locale: "en-US",
            timezone: "UTC",
            companyName: "Renamed Name ApS",
            companyLogo: "data:image/png;base64,AAAA",
          },
        },
      },
      decisionState: "pending",
    }, "tok.en")

    expect(session.locale).toBe("da-DK")
    expect(session.quote.timezone).toBe("Europe/Copenhagen")
    expect(session.seller).toEqual({
      name: "Frozen Name ApS",
      logo: "/q/tok.en/logo",
    })
  })

  it("keeps an uploaded logo out of the page data of an invoice and a quote", () => {
    const logo = `data:image/png;base64,${"A".repeat(200_000)}`
    const settings = { locale: "en-US", timezone: "UTC", companyName: "Acme", companyLogo: logo }
    const invoice = serializePublicInvoiceSession({
      invoice: {
        id: "invoice-1",
        number: "INV-0001",
        status: "sent",
        paymentStatus: "unpaid",
        issueDate: new Date("2026-03-09T00:00:00.000Z"),
        dueDate: new Date("2026-03-23T00:00:00.000Z"),
        totalGross: decimal(100),
        amountPaid: decimal(0),
        amountCredited: decimal(0),
        totalTax: decimal(0),
        subtotalNet: decimal(100),
        currency: "USD",
        locale: "en-US",
        timezone: "UTC",
        notes: null,
        sellerSnapshot: null,
        buyerSnapshot: null,
        contact: { name: "Kunde", email: null, company: null },
        items: [],
        organization: { settings },
      },
      paymentState: "unpaid",
      stripeEnabled: false,
    }, "tok.en")
    const quote = serializePublicQuoteSession({
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
        locale: "en-US",
        timezone: "UTC",
        notes: null,
        sellerSnapshot: null,
        buyerSnapshot: null,
        publicDecisionAt: null,
        publicRejectionReason: null,
        contact: { name: "Kunde", email: null, company: null },
        items: [],
        invoices: [],
        organization: { settings },
      },
      decisionState: "pending",
    }, "tok.en")

    expect(invoice.seller.logo).toBe("/pay/tok.en/logo")
    expect(quote.seller.logo).toBe("/q/tok.en/logo")
    expect(JSON.stringify(invoice)).not.toContain("data:image")
    expect(JSON.stringify(quote)).not.toContain("data:image")
    expect(JSON.stringify(invoice).length).toBeLessThan(5_000)
  })
})
