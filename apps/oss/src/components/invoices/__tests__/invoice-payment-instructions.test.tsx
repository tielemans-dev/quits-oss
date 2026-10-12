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
      <InvoiceSellerDetails sellerSnapshot={sellerSnapshot} />
      <InvoicePaymentInstructions sellerSnapshot={sellerSnapshot} number="INV-0042" total={250} currency="DKK" dueDate="2026-03-23" />
    </I18nProvider>)
    for (const value of ["Synthetic Seller ApS", "Testvej 1", "1000 København", "CVR-nr.: 12345678", "0040", "0440 116 243", "Frozen note"]) expect(html).toContain(value)
    expect(html).toContain(locale === "da-DK" ? 'aria-label="Fra"' : 'aria-label="From"')
    expect(html).toContain(locale === "da-DK" ? "Skriv fakturanummeret i beskeden, så vi kan finde din betaling." : "Add the invoice number to the payment message so we can match your payment.")
    expect(html).toContain(locale === "da-DK" ? "Betalingsbesked" : "Payment message")
    expect(html).toContain(locale === "da-DK" ? "23. mar. 2026" : "23 Mar 2026")
    expect(html).not.toMatch(/Payment reference|Betalingsreference|\+71/)
  })

  it.each([null, {}, { companyName: 42 }])("hides absent or invalid bank data: %s", snapshot => {
    const html = renderToStaticMarkup(<I18nProvider locale="en-US"><InvoicePaymentInstructions sellerSnapshot={snapshot} number="INV-0042" total={250} currency="DKK" dueDate="2026-03-23" /></I18nProvider>)
    expect(html).toBe("")
  })

  it("shows a payment note without bank rows and never assigns a draft number", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en-US"><InvoicePaymentInstructions sellerSnapshot={{ paymentNote: "Pay on delivery" }} number={null} total={250} currency="DKK" dueDate="2026-03-23" /></I18nProvider>)
    expect(html).toContain("Pay on delivery")
    expect(html).not.toMatch(/Reg. no.|Account number|Put invoice number/)
  })
})
