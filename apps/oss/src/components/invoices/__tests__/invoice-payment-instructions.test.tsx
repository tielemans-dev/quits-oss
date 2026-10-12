import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider } from "../../../lib/i18n/react"
import { InvoiceSellerDetails, InvoicePaymentInstructions } from "../invoice-payment-instructions"

const sellerSnapshot = {
  companyName: "Synthetic Seller ApS", companyAddress: "Testvej 1\n1000 København",
  taxIds: [{ scheme: "cvr", countryCode: "DK", value: "12345678" }],
  bankAccount: { regNumber: "0040", accountNumber: "0440116243" }, paymentNote: "Frozen note",
}

describe("invoice detail seller and payment blocks", () => {
  it.each(["da-DK", "en-US"])("renders the invoice's frozen seller and payment data in %s", locale => {
    const html = renderToStaticMarkup(<I18nProvider locale={locale}>
      <InvoiceSellerDetails status="sent" sellerSnapshot={sellerSnapshot} />
      <InvoicePaymentInstructions status="sent" sellerSnapshot={sellerSnapshot} number="INV-0042" balanceDue={250} currency="DKK" dueDate="2026-03-23" />
    </I18nProvider>)
    for (const value of ["Synthetic Seller ApS", "Testvej 1", "1000 København", "CVR-nr.: 12345678", "0040", "0440 116 243", "Frozen note"]) expect(html).toContain(value)
    expect(html).toContain(locale === "da-DK" ? 'aria-label="Fra"' : 'aria-label="From"')
    expect(html).toContain(locale === "da-DK" ? "Skriv fakturanummeret i beskeden, så vi kan finde din betaling." : "Add the invoice number to the payment message so we can match your payment.")
    expect(html).toContain(locale === "da-DK" ? "Betalingsbesked" : "Payment message")
    expect(html).toContain(locale === "da-DK" ? "23. mar. 2026" : "23 Mar 2026")
    expect(html).not.toMatch(/Payment reference|Betalingsreference|\+71/)
  })

  it.each(["da-DK", "en-US"])("hides the creation-time seller while the invoice is a draft in %s", locale => {
    const html = renderToStaticMarkup(<I18nProvider locale={locale}><InvoiceSellerDetails status="draft" sellerSnapshot={sellerSnapshot} /></I18nProvider>)
    expect(html).toBe("")
  })

  it.each([null, {}, { companyName: 42 }])("hides absent or invalid bank data: %s", snapshot => {
    const html = renderToStaticMarkup(<I18nProvider locale="en-US"><InvoicePaymentInstructions status="sent" sellerSnapshot={snapshot} number="INV-0042" balanceDue={250} currency="DKK" dueDate="2026-03-23" /></I18nProvider>)
    expect(html).toBe("")
  })

  it("shows a payment note without bank rows and never assigns a draft number", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en-US"><InvoicePaymentInstructions status="sent" sellerSnapshot={{ paymentNote: "Pay on delivery" }} number={null} balanceDue={250} currency="DKK" dueDate="2026-03-23" /></I18nProvider>)
    expect(html).toContain("Pay on delivery")
    expect(html).not.toMatch(/Reg. no.|Account number|Put invoice number/)
  })
})

// MOCK: synthetic issued account and outstanding balances, confined to tests.
describe("issued payment block regressions", () => {
  for (const locale of ["da-DK", "en-US"]) {
    it.each([
      ["  ORDER-2026-42  ", "ORDER-2026-42"],
      ["  ", "INV-0042"],
      [null, "INV-0042"],
      [undefined, "INV-0042"],
      ["  INV-0042  ", "INV-0042"],
    ])(`renders matching ${locale} payment rows and hints: %s`, (paymentReference, expected) => {
      const html = renderToStaticMarkup(<I18nProvider locale={locale}><InvoicePaymentInstructions status="sent" sellerSnapshot={sellerSnapshot} number="INV-0042" paymentReference={paymentReference} balanceDue={250} currency="DKK" dueDate="2026-03-23" /></I18nProvider>)
      expect(html).toContain(`<dd class="font-mono text-right break-words">${expected}</dd>`)
      const defaultHint = locale === "da-DK" ? "Skriv fakturanummeret i beskeden, så vi kan finde din betaling." : "Add the invoice number to the payment message so we can match your payment."
      if (expected === "INV-0042") expect(html).toContain(defaultHint)
      else {
        expect(html).toContain(locale === "da-DK" ? `Skriv ${expected} i beskeden, så vi kan finde din betaling.` : `Add ${expected} to the payment message so we can match your payment.`)
        expect(html).not.toContain(defaultHint)
        expect(html).not.toContain("INV-0042")
      }
    })
  }

  it("escapes a custom reference in both the detail row and hint", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en-US"><InvoicePaymentInstructions status="sent" sellerSnapshot={sellerSnapshot} number="INV-0042" paymentReference="<img src=x>" balanceDue={250} currency="DKK" dueDate="2026-03-23" /></I18nProvider>)
    expect(html).toContain("Add &lt;img src=x&gt; to the payment message so we can match your payment.")
    expect(html).not.toContain("<img")
  })

  it("shows an IBAN-only destination", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en-US"><InvoicePaymentInstructions status="sent" sellerSnapshot={{ bankAccount: { iban: "DK5000400440116243", bic: "DABADKKK" } }} number="INV-0042" balanceDue={250} currency="DKK" dueDate="2026-03-23" /></I18nProvider>)
    expect(html).toContain("DK50 0040 0440 1162 43")
    expect(html).toContain("DABADKKK")
  })

  it.each([1000, 750, 0])("shows the supplied outstanding amount %s", balanceDue => {
    const html = renderToStaticMarkup(<I18nProvider locale="en-US"><InvoicePaymentInstructions status="sent" sellerSnapshot={sellerSnapshot} number="INV-0042" balanceDue={balanceDue} currency="USD" dueDate="2026-03-23" /></I18nProvider>)
    expect(html).toContain(balanceDue === 1000 ? "$1,000.00" : balanceDue === 750 ? "$750.00" : "$0.00")
    expect(html).toContain("INV-0042")
  })

  it("hides draft creation-time payment details even after settings change", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en-US"><InvoicePaymentInstructions status="draft" sellerSnapshot={sellerSnapshot} number={null} balanceDue={250} currency="DKK" dueDate="2026-03-23" /></I18nProvider>)
    expect(html).toBe("")
  })
})
