import { describe, expect, it } from "vitest"
import { Prisma } from "../../../generated/prisma/client"
import { buildInvoiceEmailContent, type SendInvoiceEmailParams } from "../email"
import { composeInvoiceEmail, type InvoiceForEmail } from "../../domain/documents/invoice-email"
import fixture from "../../domain/events/__tests__/fixtures/invoice.issued.v1.json"

const bankAccount = { regNumber: "0040", accountNumber: "0440116243" }
const invoice = {
  number: "INV-0042", issueDate: "2026-03-09", dueDate: "2026-03-23", currency: "DKK",
  subtotal: 1000, taxAmount: 250, total: 1250, items: [], notes: "Invoice note",
}
const copies = [
  ["da-DK", "Sådan betaler du", "Reg.nr.", "Kontonummer", "Skriv fakturanummeret i beskeden, så vi kan finde din betaling.", "Betal faktura"],
  ["en-US", "How to pay", "Reg. no.", "Account number", "Add the invoice number to the payment message so we can match your payment.", "Pay invoice"],
] as const

describe("invoice email payment instructions", () => {
  for (const [locale, heading, reg, account, reference, button] of copies) {
    // MOCK: synthetic frozen payment details and public checkout URL, confined to tests.
    it.each([
      {},
      { bankAccount: null, paymentNote: null },
      { bankAccount: {}, paymentNote: "" },
      { bankAccount: { regNumber: "  ", accountNumber: "\t", iban: "\n" }, paymentNote: "  " },
    ])(`omits the entire ${locale} payment section when no method is available: %j`, details => {
      const content = buildInvoiceEmailContent({
        invoice: { ...invoice, ...details, items: [{ description: "Consulting", quantity: 1, unitPrice: 1000, total: 1000 }] },
        org: { locale, companyName: "Frozen seller" }, contactName: "Synthetic buyer", publicPaymentUrl: null,
      })
      expect(content.html).not.toContain(heading)
      expect(content.html).not.toContain(locale === "da-DK" ? "Betalingsbesked" : "Payment message")
      expect(content.html).not.toContain(reference)
      expect(content.html).not.toContain(button)
      for (const value of ["Frozen seller", "Synthetic buyer", "Consulting", "INV-0042", "Invoice note"]) {
        expect(content.html).toContain(value)
      }
      const total = locale === "da-DK" ? "1.250,00\u00a0kr." : "DKK\u00a01,250.00"
      expect(content.html).toContain(total)
      expect(content.subject).toContain(total)
    })

    it.each([
      { total: 0, balanceDue: undefined },
      { total: -10, balanceDue: undefined },
      { total: 1250, balanceDue: 0 },
      { total: 1250, balanceDue: -10 },
    ])(`omits all ${locale} payment content for a non-positive effective balance: %j`, amounts => {
      const html = buildInvoiceEmailContent({
        invoice: { ...invoice, ...amounts, bankAccount, paymentReference: "ORDER-42", paymentNote: "Frozen payment note" },
        org: { locale }, contactName: "Buyer", publicPaymentUrl: "https://app.example.invalid/pay/token",
      }).html
      for (const value of [heading, reference, button, "ORDER-42", "Frozen payment note", "0440 116 243", "https://app.example.invalid/pay/token", "Virker knappen ikke?", "Button not working?"]) expect(html).not.toContain(value)
      expect(html).toContain("Invoice note")
    })

    const methods: Array<{ name: string; details: Partial<SendInvoiceEmailParams["invoice"]>; url?: string; value?: string }> = [
      { name: "bank account only", details: { bankAccount }, value: "0440 116 243" },
      { name: "IBAN only", details: { bankAccount: { iban: "DK5000400440116243" } }, value: "DK50 0040 0440 1162 43" },
      { name: "bank name only", details: { bankAccount: { bankName: "Frozen bank" } }, value: "Frozen bank" },
      { name: "payment note only", details: { paymentNote: "MobilePay Box 12345" }, value: "MobilePay Box 12345" },
      { name: "public Stripe payment URL only", details: {}, url: "https://app.example.invalid/pay/token" },
    ]
    it.each(methods)(`keeps ${locale} instructions for $name and the outstanding balance`, ({ details, url, value }) => {
      const content = buildInvoiceEmailContent({
        invoice: { ...invoice, ...details, balanceDue: 750 }, org: { locale }, contactName: "Buyer", publicPaymentUrl: url,
      })
      const payment = content.html.match(new RegExp(`<table aria-label="${heading}"[\\s\\S]*?</table>`))?.[0]
      expect(payment).toBeDefined()
      expect(payment).toContain(locale === "da-DK" ? "750,00\u00a0kr." : "DKK\u00a0750.00")
      expect(payment).toContain(locale === "da-DK" ? "Betalingsbesked" : "Payment message")
      expect(payment).toContain("INV-0042")
      expect(content.html).toContain(reference)
      if (value) expect(content.html).toContain(value)
      expect(content.html.includes(button)).toBe(Boolean(url))
      if (url) expect(content.html).toContain(`href="${url}"`)
      const total = locale === "da-DK" ? "1.250,00\u00a0kr." : "DKK\u00a01,250.00"
      expect(content.html.slice(0, content.html.indexOf(`<table aria-label="${heading}"`))).toContain(total)
      expect(content.subject).toContain(total)
      expect(content.html).toContain("Invoice note")
    })

    it.each([true, false])(`renders the approved ${locale} copy with bank details: %s`, withBank => {
      const html = buildInvoiceEmailContent({
        invoice: { ...invoice, bankAccount: withBank ? bankAccount : null, paymentNote: "Frozen payment note" },
        org: { locale }, contactName: "Synthetic buyer", publicPaymentUrl: "https://app.example.invalid/pay/token",
      }).html
      const sequence = [heading, ...(withBank ? [reg, "0040", account, "0440 116 243"] : []), locale === "da-DK" ? "Betalingsbesked" : "Payment message", "INV-0042", reference, "Frozen payment note", button, "Invoice note"]
      let previous = html.indexOf("font-size:18px")
      expect(previous).toBeGreaterThan(0)
      for (const copy of sequence) {
        const index = html.indexOf(copy, previous + 1)
        expect(index, copy).toBeGreaterThan(previous)
        previous = index
      }
      expect(html.includes(reg)).toBe(withBank)
      expect(html.includes(account)).toBe(withBank)
      expect(html).toContain('href="https://app.example.invalid/pay/token"')
      const question = locale === "da-DK" ? "Virker knappen ikke?" : "Button not working?"
      const link = locale === "da-DK" ? "Åbn betalingssiden" : "Open the payment page"
      const fallback = html.match(/<p[^>]*>([^<]*<a href="https:\/\/app\.example\.invalid\/pay\/token"[^>]*>[^<]*<\/a>)<\/p>/)?.[1]
      expect(fallback?.replace(/<[^>]+>/g, "")).toBe(`${question} ${link}`)
      expect(fallback).toContain(`${question} <a `)
      expect(fallback).toContain(`>${link}</a>`)
      expect(html.match(new RegExp(`>\\s*${button}\\s*</a>`, "g"))).toHaveLength(1)
      expect(html).toContain(locale === "da-DK" ? "Beløb" : "Amount")
      expect(html).toContain(locale === "da-DK" ? "23. mar. 2026" : "23 Mar 2026")
      expect(html).toContain(locale === "da-DK" ? "9. mar. 2026" : "9 Mar 2026")
      expect(html).not.toContain('>https://app.example.invalid/pay/token</a>')
      expect(html).not.toMatch(/Payment reference|Betalingsreference|\+71/)
    })
  }

  it("escapes snapshot values, the invoice number and multiline payment notes", () => {
    const html = buildInvoiceEmailContent({ invoice: { ...invoice, number: '<img src=x>', bankAccount: { regNumber: '<script>', accountNumber: '"&' }, paymentNote: '<b>Pay</b>\nSecond line' }, org: { locale: "en-US" }, contactName: "Buyer" }).html
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("&quot;&amp;")
    expect(html).toContain("&lt;img src=x&gt;")
    expect(html).toContain("&lt;b&gt;Pay&lt;/b&gt;<br />Second line")
    expect(html).not.toContain("<img")
  })

  it("renders transfer instructions even when no online payment URL exists", () => {
    const html = buildInvoiceEmailContent({ invoice: { ...invoice, bankAccount }, org: { locale: "en-US" }, contactName: "Buyer" }).html
    expect(html).toContain("0440 116 243")
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
  subtotalNet: decimal(1000), totalTax: decimal(250), totalGross: decimal(1250), pricesIncludeTax: false, amountPaid: decimal(0), amountCredited: decimal(0),
  contact: { name: "Buyer", email: "buyer@example.invalid" },
  sellerSnapshot: { bankAccount, paymentNote: "Legacy frozen note" },
}
const compose = (document: InvoiceForEmail, org = settings) => composeInvoiceEmail({ invoice: document, settings: org, to: "buyer@example.invalid", publicPaymentUrl: "https://app.example.invalid/pay/token" }).message.html

describe("frozen invoice email payment details", () => {
  it("prefers the issue-time snapshot over both row snapshots and current settings", () => {
    const document = { ...storedInvoice, issuanceSnapshot: { ...fixture.cases[0]!.payload, seller: { companyName: "Frozen Seller", companyAddress: "Testvej 42\n9000 Aalborg", taxIds: [{ scheme: "cvr", countryCode: "DK", value: "12345678" }], bankAccount: { regNumber: "5678", accountNumber: "0123456789" }, paymentNote: "Issue-time note" } } }
    const before = compose(document)
    const after = compose(document, { ...settings, bankRegNumber: "9999", bankAccountNumber: "1111111", paymentNote: "Changed settings note" })
    expect(after).toBe(before)
    expect(before).toContain("5678")
    expect(before).toContain("0123 456 789")
    expect(before).toContain("Issue-time note")
    expect(before).toContain("Testvej 42<br />9000 Aalborg")
    expect(before).toContain("CVR-nr.: 12345678")
    expect(before).not.toMatch(/0040|0440116243|Legacy frozen note|Current payment note|9876543/)
  })

  it("keeps an issue-time snapshot sparse instead of filling from the row or settings", () => {
    const html = compose({ ...storedInvoice, issuanceSnapshot: { ...fixture.cases[0]!.payload, seller: {} } })
    expect(html).not.toMatch(/Reg.nr.|Kontonummer|Legacy frozen note|Current payment note/)
  })

  it.each(copies)("omits payment instructions for a sparse issued %s snapshot despite current payment settings", (locale, heading, _reg, _account, reference, button) => {
    const document = { ...storedInvoice, locale, issuanceSnapshot: { ...fixture.cases[0]!.payload, seller: { companyName: "Frozen seller" } } }
    const html = composeInvoiceEmail({ invoice: document, settings, to: "buyer@example.invalid", publicPaymentUrl: null }).message.html
    expect(html).toContain("Frozen seller")
    expect(html).toContain("INV-0042")
    expect(html).toContain("Invoice note")
    for (const value of [heading, reference, button, "Legacy frozen note", "Current payment note", "9876543", "0040"]) {
      expect(html).not.toContain(value)
    }
  })

  it("uses legacy issued row snapshots and never invents missing historic bank details", () => {
    expect(compose(storedInvoice)).toContain("0040")
    expect(compose(storedInvoice)).toContain("Legacy frozen note")
    for (const sellerSnapshot of [null, {}, { companyName: 42 }]) {
      const html = compose({ ...storedInvoice, sellerSnapshot })
      expect(html).not.toMatch(/Reg.nr.|Kontonummer|Current payment note|9876543/)
    }
  })
})

// MOCK: synthetic settlement/account fixtures, confined to tests.
describe("issued transfer regressions", () => {
  for (const [locale, heading, _reg, _account, hint, button] of copies) {
    it("omits payment collection in real initial zero invoice composition in " + locale, () => {
      const document: InvoiceForEmail = {
        ...storedInvoice, locale,
        subtotalNet: decimal(0), totalTax: decimal(0), totalGross: decimal(0),
        amountPaid: decimal(0), amountCredited: decimal(0), paymentReference: "ZERO-ORDER-42",
        items: [{ description: "Complimentary service", quantity: decimal(1), unitPriceNet: decimal(0), unitPriceGross: decimal(0), lineNet: decimal(0), lineTax: decimal(0), lineGross: decimal(0), taxRate: decimal(0), vatTreatment: "standard", vatReasonCode: null, vatCountry: "DK", vatRateInput: null }],
      }
      const before = JSON.stringify(document)
      const { message } = composeInvoiceEmail({ invoice: document, settings, to: "buyer@example.invalid", publicPaymentUrl: "https://app.example.invalid/pay/token" })
      for (const value of [heading, hint, button, "ZERO-ORDER-42", "Legacy frozen note", "0440 116 243", "https://app.example.invalid/pay/token", "Virker knappen ikke?", "Button not working?"]) expect(message.html).not.toContain(value)
      const total = locale === "da-DK" ? "0,00\u00a0kr." : "DKK\u00a00.00"
      expect(message.html).toContain(total)
      expect(message.subject).toContain(total)
      expect(message.html).toContain("Complimentary service")
      expect(message.html).toContain("Invoice note")
      expect(JSON.stringify(document)).toBe(before)
    })

    it.each([[1250, 0], [0, 1250], [500, 750], [1500, 0], [0, 1500]])("omits settled payment content in " + locale + " for paid %s / credited %s", (paid, credited) => {
      const document = { ...storedInvoice, locale, paymentReference: "SETTLED-42", amountPaid: decimal(paid), amountCredited: decimal(credited) }
      const before = JSON.stringify(document)
      const html = compose(document)
      for (const value of [heading, hint, button, "SETTLED-42", "Legacy frozen note", "0440 116 243", "https://app.example.invalid/pay/token", "Virker knappen ikke?", "Button not working?"]) expect(html).not.toContain(value)
      expect(html).toContain(locale === "da-DK" ? "1.250,00\u00a0kr." : "DKK\u00a01,250.00")
      expect(html).toContain("Invoice note")
      expect(JSON.stringify(document)).toBe(before)
    })

    it.each([[500, 0, 2000], [500, 250, 1750]])("preserves partial instructions in " + locale + " for paid %s / credited %s", (paid, credited, balance) => {
      const document = { ...storedInvoice, locale, totalGross: decimal(2500), subtotalNet: decimal(2000), totalTax: decimal(500), paymentReference: "PARTIAL-42", amountPaid: decimal(paid), amountCredited: decimal(credited) }
      const before = JSON.stringify(document)
      const { message } = composeInvoiceEmail({ invoice: document, settings, to: "buyer@example.invalid", publicPaymentUrl: "https://app.example.invalid/pay/token" })
      const html = message.html
      const payment = html.match(new RegExp(`<table aria-label="${heading}"[\\s\\S]*?</table>`))?.[0]
      expect(payment).toContain(locale === "da-DK" ? `${balance === 2000 ? "2.000" : "1.750"},00\u00a0kr.` : `DKK\u00a0${balance === 2000 ? "2,000" : "1,750"}.00`)
      expect(payment).toContain("PARTIAL-42")
      expect(payment).toContain("0440 116 243")
      expect(html).toContain("Legacy frozen note")
      expect(html).toContain(button)
      expect(html).toContain(locale === "da-DK" ? "Skriv PARTIAL-42 i beskeden" : "Add PARTIAL-42 to the payment message")
      const total = locale === "da-DK" ? "2.500,00\u00a0kr." : "DKK\u00a02,500.00"
      expect(html.slice(0, html.indexOf(`<table aria-label="${heading}"`))).toContain(total)
      expect(message.subject).toContain(total)
      expect(JSON.stringify(document)).toBe(before)
    })
  }

  for (const [locale, heading, _reg, _account, defaultHint] of copies) {
    it.each([
      ["  ORDER-2026-42  ", "ORDER-2026-42"],
      ["  ", "INV-0042"],
      [null, "INV-0042"],
      [undefined, "INV-0042"],
      ["  INV-0042  ", "INV-0042"],
    ])(`propagates the stored reference into matching ${locale} email rows and hints: %s`, (paymentReference, expected) => {
      const html = compose({ ...storedInvoice, locale, paymentReference })
      const payment = html.match(new RegExp(`<table aria-label="${heading}"[\\s\\S]*?</table>`))?.[0]
      expect(payment).toContain(expected)
      if (expected === "INV-0042") expect(html).toContain(defaultHint)
      else {
        expect(payment).not.toContain("INV-0042")
        expect(html).toContain(locale === "da-DK" ? `Skriv ${expected} i beskeden, så vi kan finde din betaling.` : `Add ${expected} to the payment message so we can match your payment.`)
        expect(html).not.toContain(defaultHint)
      }
      expect(html).toContain("INV-0042")
    })
  }

  it("escapes a stored custom payment reference", () => {
    const html = compose({ ...storedInvoice, paymentReference: '<img src=x>' })
    expect(html).toContain("&lt;img src=x&gt;")
    expect(html).toContain("Skriv &lt;img src=x&gt; i beskeden, så vi kan finde din betaling.")
    expect(html).not.toContain("<img")
  })

  it("renders an IBAN-only issued destination and makes no remote font request", () => {
    const html = compose({ ...storedInvoice, sellerSnapshot: { bankAccount: { iban: "DK5000400440116243", bic: "DABADKKK" } } })
    expect(html).toContain("DK50 0040 0440 1162 43")
    expect(html).toContain("DABADKKK")
    expect(html).not.toMatch(/@font-face|@import|cdn\.jsdelivr\.net|\.woff2?/)
    expect(html).toContain("Consolas,monospace")
  })

  it.each([
    [250, 0, "1.000,00"], [0, 250, "1.000,00"], [250, 250, "750,00"],
  ])("uses outstanding payment amount for paid %s / credited %s without changing issued totals", (paid, credited, expected) => {
    const document = { ...storedInvoice, amountPaid: decimal(paid), amountCredited: decimal(credited) }
    const before = JSON.stringify(document)
    const html = compose(document)
    const payment = html.match(/<table aria-label="Sådan betaler du"[\s\S]*?<\/table>/)?.[0]
    expect(payment).toContain(`${expected}\u00a0kr.`)
    expect(payment).toContain(storedInvoice.number)
    expect(html.slice(0, html.indexOf('<table aria-label="Sådan betaler du"'))).toContain("1.250,00\u00a0kr.")
    expect(JSON.stringify(document)).toBe(before)
  })
})
