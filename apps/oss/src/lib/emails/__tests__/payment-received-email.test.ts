import { describe, expect, it } from "vitest"
import { buildPaymentReceivedEmailContent } from "../payment-received-email"

const base = {
  fromName: "Acme <ApS>",
  fromEmail: "billing@acme.test",
  replyTo: "hello@acme.test",
  invoice: { number: "2026-0042" },
  payment: { amount: 1250.5, currency: "DKK", paidAt: new Date("2026-06-01T22:30:00Z") },
  sellerName: "Acme ApS",
  contactName: "Kunde & Co",
  sellerEmail: "hello@acme.test",
}

describe("payment received email", () => {
  it("confirms the payment to the customer in Danish", () => {
    const content = buildPaymentReceivedEmailContent({
      ...base,
      audience: "client",
      org: { locale: "da-DK", timezone: "Europe/Copenhagen" },
    })

    expect(content.subject).toBe("Betaling modtaget for faktura 2026-0042")
    expect(content.html).toContain("Tak for din betaling")
    expect(content.html).toContain("Acme ApS har modtaget din betaling for faktura 2026-0042.")
    expect(content.html).toContain("2. juni 2026")
    expect(content.html).toContain("1.250,50")
    expect(content.html).toContain("Kunde &amp; Co")
    expect(content.html).not.toContain("Kunde & Co")
    expect(content.html).toContain("hello@acme.test")
    expect(content.replyTo).toBe("hello@acme.test")
    expect(content.fromAddress).toContain("billing@acme.test")
  })

  it("confirms the payment to the customer in English", () => {
    const content = buildPaymentReceivedEmailContent({
      ...base,
      audience: "client",
      org: { locale: "en-US", timezone: "UTC" },
    })

    expect(content.subject).toBe("Payment received for invoice 2026-0042")
    expect(content.html).toContain("Thank you for your payment")
    expect(content.html).toContain("Acme ApS has received your payment for invoice 2026-0042.")
    expect(content.html).toContain("June 1, 2026")
    expect(content.html).toContain("DKK")
  })

  it("tells the seller who paid, in Danish and English", () => {
    const da = buildPaymentReceivedEmailContent({ ...base, audience: "seller", org: { locale: "da-DK", timezone: "UTC" } })
    expect(da.subject).toBe("Kunde & Co har betalt faktura 2026-0042")
    expect(da.html).toContain("Betaling modtaget")
    expect(da.html).toContain("Kunde &amp; Co har betalt faktura 2026-0042.")
    expect(da.html).not.toContain("Hej")

    const en = buildPaymentReceivedEmailContent({ ...base, audience: "seller", org: { locale: "en-US", timezone: "UTC" } })
    expect(en.subject).toBe("Kunde & Co paid invoice 2026-0042")
    expect(en.html).toContain("Kunde &amp; Co has paid invoice 2026-0042.")
    expect(en.html).not.toContain("Hi ")
  })

  it("makes no promises beyond the payment and never calls Quits open source", () => {
    for (const locale of ["da-DK", "en-US"]) {
      for (const audience of ["client", "seller"] as const) {
        const { html } = buildPaymentReceivedEmailContent({ ...base, audience, org: { locale, timezone: "UTC" } })
        expect(html).not.toMatch(/open source|åben kildekode|bogføring|bookkeeping|receipt|kvittering/i)
      }
    }
  })

  it("keeps header injection out of the sender and subject", () => {
    const content = buildPaymentReceivedEmailContent({
      ...base,
      audience: "seller",
      fromName: "Acme\r\nBcc: x@evil.test",
      contactName: "Eve\r\nBcc: y@evil.test",
      org: { locale: "en-US", timezone: "UTC" },
    })
    expect(content.subject).not.toMatch(/[\r\n]/)
    expect(content.fromAddress).not.toMatch(/[\r\n]/)
  })
})
