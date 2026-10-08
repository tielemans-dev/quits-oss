import { describe, expect, it } from "vitest"
import {
  buildInvitationEmailContent,
  buildInvoiceEmailContent,
  buildQuoteEmailContent,
} from "../email"

describe("email localization", () => {
  it("renders danish quote subject and content", () => {
    const result = buildQuoteEmailContent({
      quote: {
        number: "QTE-0001",
        issueDate: "2026-03-01T00:00:00.000Z",
        expiryDate: "2026-03-27T00:00:00.000Z",
        subtotal: 1000,
        taxAmount: 250,
        total: 1250,
        currency: "DKK",
        notes: "Tak for samarbejdet",
        items: [
          {
            description: "Konsulentydelse",
            quantity: 1,
            unitPrice: 1250,
            total: 1250,
          },
        ],
      },
      org: {
        companyName: "Nordic Services",
        companyEmail: "finance@nordic.test",
        locale: "da-DK",
        timezone: "Europe/Copenhagen",
      },
      contactName: "Martin",
    })

    expect(result.subject).toContain("Tilbud QTE-0001")
    expect(result.subject).toContain("gyldigt til")
    expect(result.html).toContain("Hej Martin, her er dit tilbud.")
    expect(result.html).toContain("Gyldig til")
  })

  it("renders danish invitation content", () => {
    const result = buildInvitationEmailContent({
      inviterName: "Mia",
      orgName: "Nordic Services",
      invitationUrl: "https://yaip.test/accept",
      locale: "da-DK",
    })

    expect(result.subject).toContain("Mia inviterede dig")
    expect(result.subject).toContain("Nordic Services")
    expect(result.html).toContain("Du er inviteret til at blive en del af Nordic Services")
    expect(result.html).toContain("Accepter invitation")
    expect(result.html).toContain("Denne invitation udløber om 48 timer.")
  })
})


describe("document email calendar dates", () => {
  it.each(["America/New_York", "Pacific/Pago_Pago", "Europe/Copenhagen"])(
    "keeps due and expiry dates in both the subject and body in %s", timezone => {
      const document = {
        number: "DOC-0001", issueDate: "2026-10-01T00:00:00.000Z",
        subtotal: 100, taxAmount: 0, total: 100, currency: "USD", notes: null, items: [],
      }
      const org = { companyName: "Seller", locale: "en-US", timezone }
      const invoice = buildInvoiceEmailContent({
        invoice: { ...document, dueDate: "2028-02-29T00:00:00.000Z" }, org, contactName: "Buyer",
      })
      const quote = buildQuoteEmailContent({
        quote: { ...document, expiryDate: "2027-03-14T00:00:00.000Z" }, org, contactName: "Buyer",
      })
      for (const text of [invoice.subject, invoice.html]) expect(text).toContain("February 29, 2028")
      for (const text of [quote.subject, quote.html]) expect(text).toContain("March 14, 2027")
    }
  )
})
