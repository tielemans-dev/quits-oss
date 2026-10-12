import { isValidElement, type ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { Text } from "@react-pdf/renderer"
import { renderToStaticMarkup } from "react-dom/server"
import { InvoicePdfDocument, type InvoiceForPdf } from "../invoice-pdf"
import { buildInvoiceEmailContent } from "../email"
import { LocalizedDocument } from "../../components/documents/localized-document"
import { PublicInvoicePaymentPage } from "../../components/invoices/public-invoice-payment-page"
import { sellerVatLineText } from "../documents/seller-vat"

const invoice: InvoiceForPdf = {
  number: "SYNTHETIC-0042", status: "sent", issueDate: "2026-10-11T12:00:00Z", dueDate: "2026-11-09", subtotal: 100, taxAmount: 0, total: 100, currency: "DKK", notes: null, pricesIncludeTax: false,
  bankAccount: { regNumber: "0040", accountNumber: "0440116243" },
  contact: { name: "Synthetic buyer" }, items: [{ description: "Synthetic service", quantity: 1, unitPrice: 100, total: 100, taxRate: 0 }],
}
function pdfText(node: ReactNode): string[] {
  if (node == null || typeof node === "boolean") return []
  if (typeof node === "string" || typeof node === "number") return [String(node)]
  if (Array.isArray(node)) return node.flatMap(pdfText)
  if (isValidElement<{ children?: ReactNode }>(node)) { const children = pdfText(node.props.children); return node.type === Text ? [children.join("")] : children }
  return []
}
function outputs(locale: string, momsRegistered?: boolean | null) {
  const taxRate = momsRegistered ? 25 : 0
  const document = { ...invoice, momsRegistered, items: [{ ...invoice.items[0]!, taxRate }] }
  return [
    pdfText(InvoicePdfDocument({ invoice: document, org: { locale } })).join(" "),
    buildInvoiceEmailContent({ invoice: { ...document, priceBasis: "net" }, org: { locale }, contactName: "Synthetic buyer", publicPaymentUrl: "https://example.test/pay/test" }).html,
    renderToStaticMarkup(<LocalizedDocument locale={locale}><PublicInvoicePaymentPage token="synthetic" state={{ kind: "ready", paymentState: "unpaid", stripeEnabled: false, seller: { name: "Synthetic seller", logo: null }, invoice: {
      ...document, id: "synthetic", timezone: "Europe/Copenhagen", paymentStatus: "unpaid", subtotalNet: 100, totalTax: 0, totalGross: 100, buyerSnapshot: null,
      sellerSnapshot: { momsRegistered, bankAccount: invoice.bankAccount }, contact: { name: "Synthetic buyer", email: null, company: null },
      items: [{ id: "synthetic-line", description: "Synthetic service", quantity: 1, unitPriceNet: 100, unitPriceGross: 100, lineNet: 100, lineGross: 100, sortOrder: 0, taxRate }],
    } }} /></LocalizedDocument>),
  ]
}
describe("seller VAT presentation", () => {
  it.each([
    ["da-DK", "Ingen moms", "Virksomheden er ikke momsregistreret.", "Betalingsoplysninger"],
    ["en-US", "No moms", "The company is not VAT registered.", "Payment details"],
  ])("renders the exact %s note and plain line text before payment", (locale, line, note, paymentTitle) => {
    const [pdf, email, pay] = outputs(locale, false)
    for (const output of [pdf!, email!, pay!]) {
      expect(output).toContain(line)
      expect(output).toContain(note)
    }
    expect(pdf!.indexOf(note)).toBeLessThan(pdf!.indexOf(paymentTitle))
    expect(pay!.indexOf(note)).toBeLessThan(pay!.indexOf(paymentTitle))
    expect(email!.indexOf(note)).toBeLessThan(email!.indexOf("https://example.test/pay/test"))
  })
  it.each(["da-DK", "en-US"])("keeps registered 25 %% moms text and omits the non-registration note in %s", locale => {
    for (const output of outputs(locale, true)) {
      expect(output).toContain("25 % moms")
      expect(output).not.toMatch(/The company is not VAT registered|Virksomheden er ikke momsregistreret/)
    }
  })
  it.each([null, undefined])("keeps historic documents without a status unchanged: %s", status => {
    for (const output of outputs("en-US", status)) expect(output).not.toMatch(/No moms|The company is not VAT registered|25 % moms/)
  })
  it("does not label other registered rates as 25 %%", () => {
    expect(sellerVatLineText(true, 20, "en-US")).toBeNull()
  })
})
