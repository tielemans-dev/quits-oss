import { describe, expect, it } from "vitest"
import { Prisma } from "../../../generated/prisma/client"
import { buildInvoiceEmailContent } from "../email"
import { composeInvoiceEmail, type InvoiceForEmail } from "../../domain/documents/invoice-email"
import fixture from "../../domain/events/__tests__/fixtures/invoice.issued.v1.json"

const bankAccount = { regNumber: "0040", accountNumber: "0440116243" }
const invoice = {
  number: "INV-0042", issueDate: "2026-10-01", dueDate: "2026-11-01", currency: "DKK",
  subtotal: 1000, taxAmount: 250, total: 1250, items: [], notes: "Invoice note",
}
const copies = [
  ["da-DK", "Sådan betaler du", "Reg.nr.", "Kontonummer", "Skriv fakturanummer INV-0042 i beskeden til modtager.", "Betal faktura"],
  ["en-US", "How to pay", "Reg. no.", "Account number", "Put invoice number INV-0042 in the payment message.", "Pay invoice"],
] as const

describe("invoice email payment instructions", () => {
  for (const [locale, heading, reg, account, reference, button] of copies) {
    it.each([true, false])(`renders the approved ${locale} copy with bank details: %s`, withBank => {
      const html = buildInvoiceEmailContent({
        invoice: { ...invoice, bankAccount: withBank ? bankAccount : null, paymentNote: "Frozen payment note" },
        org: { locale }, contactName: "Synthetic buyer", publicPaymentUrl: "https://app.example.invalid/pay/token",
      }).html
      const sequence = [heading, ...(withBank ? [`${reg}: 0040`, `${account}: 0440116243`] : []), reference, "Frozen payment note", button, "Invoice note"]
      let previous = html.indexOf("font-size:18px")
      expect(previous).toBeGreaterThan(0)
      for (const copy of sequence) {
        const index = html.indexOf(copy)
        expect(index, copy).toBeGreaterThan(previous)
        previous = index
      }
      expect(html.includes(`${reg}:`)).toBe(withBank)
      expect(html.includes(`${account}:`)).toBe(withBank)
      expect(html).toContain('href="https://app.example.invalid/pay/token"')
      expect(html).not.toMatch(/Payment reference|Betalingsreference|\+71/)
    })
  }

  it("escapes snapshot values, the invoice number and multiline payment notes", () => {
    const html = buildInvoiceEmailContent({ invoice: { ...invoice, number: '<img src=x>', bankAccount: { regNumber: '<script>', accountNumber: '"&' }, paymentNote: '<b>Pay</b>\nSecond line' }, org: { locale: "en-US" }, contactName: "Buyer" }).html
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("&quot;&amp;")
    expect(html).toContain("Put invoice number &lt;img src=x&gt; in the payment message.")
    expect(html).toContain("&lt;b&gt;Pay&lt;/b&gt;<br />Second line")
    expect(html).not.toContain("<img")
  })

  it("renders transfer instructions even when no online payment URL exists", () => {
    const html = buildInvoiceEmailContent({ invoice: { ...invoice, bankAccount }, org: { locale: "en-US" }, contactName: "Buyer" }).html
    expect(html).toContain("Account number: 0440116243")
    expect(html).not.toContain("Pay invoice")
  })
})

const decimal = (value: number) => new Prisma.Decimal(value)
const settings = {
  companyName: "Current seller", companyEmail: "current@example.invalid", locale: "en-US", timezone: "UTC",
  stripePublishableKey: null, stripeSecretKeyEnc: null, stripeWebhookSecretEnc: null,
  documentSendingDomain: null, documentSendingDomainStatus: null,
  bankRegNumber: "1234", bankAccountNumber: "9876543", paymentNote: "Current payment note",
}
const storedInvoice: InvoiceForEmail = {
  ...invoice, id: "synthetic", locale: "da-DK", timezone: "Europe/Copenhagen",
  issueDate: new Date("2026-10-01"), dueDate: new Date("2026-11-01"),
  subtotalNet: decimal(1000), totalTax: decimal(250), totalGross: decimal(1250), pricesIncludeTax: false,
  contact: { name: "Buyer", email: "buyer@example.invalid" },
  sellerSnapshot: { bankAccount, paymentNote: "Legacy frozen note" },
}
const compose = (document: InvoiceForEmail, org = settings) => composeInvoiceEmail({ invoice: document, settings: org, to: "buyer@example.invalid", publicPaymentUrl: "https://app.example.invalid/pay/token" }).message.html

describe("frozen invoice email payment details", () => {
  it("prefers the issue-time snapshot over both row snapshots and current settings", () => {
    const document = { ...storedInvoice, issuanceSnapshot: { ...fixture.cases[0]!.payload, seller: { bankAccount: { regNumber: "5678", accountNumber: "0123456789" }, paymentNote: "Issue-time note" } } }
    const before = compose(document)
    const after = compose(document, { ...settings, bankRegNumber: "9999", bankAccountNumber: "1111111", paymentNote: "Changed settings note" })
    expect(after).toBe(before)
    expect(before).toContain("Reg.nr.: 5678")
    expect(before).toContain("Kontonummer: 0123456789")
    expect(before).toContain("Issue-time note")
    expect(before).not.toMatch(/0040|0440116243|Legacy frozen note|Current payment note|9876543/)
  })

  it("keeps an issue-time snapshot sparse instead of filling from the row or settings", () => {
    const html = compose({ ...storedInvoice, issuanceSnapshot: { ...fixture.cases[0]!.payload, seller: {} } })
    expect(html).not.toMatch(/Reg.nr.:|Kontonummer:|Legacy frozen note|Current payment note/)
  })

  it("uses legacy issued row snapshots and never invents missing historic bank details", () => {
    expect(compose(storedInvoice)).toContain("Reg.nr.: 0040")
    expect(compose(storedInvoice)).toContain("Legacy frozen note")
    for (const sellerSnapshot of [null, {}, { companyName: 42 }]) {
      const html = compose({ ...storedInvoice, sellerSnapshot })
      expect(html).not.toMatch(/Reg.nr.:|Kontonummer:|Current payment note|9876543/)
    }
  })
})
