import { isValidElement, type ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { Text } from "@react-pdf/renderer"
import { renderToStaticMarkup } from "react-dom/server"
import { InvoicePdfDocument, type InvoiceForPdf } from "../invoice-pdf"
import { buildInvoiceEmailContent } from "../email"
import { LocalizedDocument } from "../../components/documents/localized-document"
import { PublicInvoicePaymentPage } from "../../components/invoices/public-invoice-payment-page"
import { serializePublicInvoiceSession } from "../payments/public-session"
import { invoiceTaxIds, sellerCvr } from "../documents/invoice-identity"

const seller = { companyName: "Synthetic Seller ApS", companyAddress: "Testvej 1, 1000 København", taxIds: [{ scheme: "cvr", value: "12345678", countryCode: "DK" }] }
const buyer = { name: "Synthetic Buyer", company: "Synthetic Buyer ApS", address: "Testvej 2", city: "København", zip: "1000", country: "DK" }
const invoice: InvoiceForPdf = { number: "SYNTHETIC-0042", status: "sent", issueDate: "2026-10-09T12:00:00Z", supplyDate: "2026-10-08", dueDate: "2026-11-09", subtotal: 1000, taxAmount: 250, total: 1250, currency: "DKK", notes: null, pricesIncludeTax: false,
  vatRows: [{ ratePercent: "25", net: "1000.00", tax: "250.00", gross: "1250.00" }], contact: buyer, items: [{ description: "Synthetic consulting", quantity: 2, unitPrice: 500, total: 1000 }] }
function pdfText(node: ReactNode): string[] {
  if (node == null || typeof node === "boolean") return []
  if (typeof node === "string" || typeof node === "number") return [String(node)]
  if (Array.isArray(node)) return node.flatMap(pdfText)
  if (isValidElement<{ children?: ReactNode }>(node)) { const children = pdfText(node.props.children); return node.type === Text ? [children.join("")] : children }
  return []
}
const normalize = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/[  ]/g, " ").replace(/\s+/g, " ")


function publicSession(document: InvoiceForPdf, buyerSnapshot: unknown = buyer, contact = { name: "Changed live buyer", company: "Changed live company", email: null as string | null }, amountPaid = 0, amountCredited = 0) {
  return serializePublicInvoiceSession({ paymentState: "unpaid", stripeEnabled: false, invoice: {
    ...document, id: "synthetic", paymentStatus: "unpaid", totalGross: document.total, subtotalNet: document.subtotal, totalTax: document.taxAmount,
    amountPaid, amountCredited, locale: "en-US", timezone: "Europe/Copenhagen", sellerSnapshot: seller, buyerSnapshot, contact,
    items: document.items.map((item, index) => ({ id: String(index), description: item.description, quantity: item.quantity, unitPriceNet: item.unitPrice, unitPriceGross: item.unitPrice, lineNet: item.total, lineGross: item.total, sortOrder: index })),
  } }, "synthetic")
}
function payHtml(session: ReturnType<typeof publicSession>, locale: string) {
  return renderToStaticMarkup(<LocalizedDocument locale={locale}><PublicInvoicePaymentPage token="synthetic" state={{ kind: "ready", ...session }} /></LocalizedDocument>)
}

describe("full invoice legal fields", () => {
  it.each(["da-DK", "en-US"])("keeps 25 percent VAT and its zero rounded amount on every output in %s", locale => {
    const tiny = { ...invoice, subtotal: 0.01, taxAmount: 0, total: 0.01, vatRows: [{ ratePercent: "25", net: "0.01", tax: "0.00", gross: "0.01" }], items: [{ description: "Tiny service", quantity: 1, unitPrice: 0.01, total: 0.01 }] }
    const session = publicSession(tiny)
    const outputs = [
      pdfText(InvoicePdfDocument({ invoice: tiny, org: { ...seller, locale } })).join(" "),
      buildInvoiceEmailContent({ invoice: { ...tiny, priceBasis: "net", buyer }, org: { ...seller, locale }, contactName: buyer.name }).html,
      payHtml({ ...session, invoice: { ...session.invoice, vatRows: tiny.vatRows } }, locale),
    ]
    for (const output of outputs) {
      const text = normalize(output)
      expect(text).toContain(locale === "da-DK" ? "Moms (25 %)" : "Tax (25%)")
      expect(text).toContain(locale === "da-DK" ? "0,00" : "0.00")
      expect(text).toContain(locale === "da-DK" ? "0,01" : "0.01")
    }
  })
  it.each(["da-DK", "en-US"])("never substitutes live buyer identity for absent historical identity in %s", locale => {
    for (const snapshot of [null, "malformed", { name: 42, company: "Invalid historical company" }]) {
      const before = publicSession(invoice, snapshot, { name: "Earlier live buyer", company: "Earlier live company", email: null })
      const after = publicSession(invoice, snapshot, { name: "Later live buyer", company: "Later live company", email: null }, 100, 50)
      expect(before.invoice.buyerSnapshot).toBeNull()
      expect(after.invoice.buyerSnapshot).toBeNull()
      for (const session of [before, after]) {
        const text = normalize(payHtml(session, locale))
        expect(text).not.toMatch(/Earlier live|Later live|Invalid historical/)
        expect(text).toContain(locale === "da-DK" ? "Ikke oplyst" : "Not provided")
      }
      expect(after.invoice.amountPaid).toBe(100)
      expect(after.invoice.amountCredited).toBe(50)
      expect(after.invoice.balanceDue).toBe(1100)
      expect(normalize(payHtml(after, locale))).toContain(locale === "da-DK" ? "1.100,00" : "1,100.00")
    }
    const frozen = publicSession(invoice, buyer, { name: "Later live buyer", company: "Later live company", email: null }, 100, 50)
    const text = normalize(payHtml(frozen, locale))
    expect(text).toContain(buyer.name)
    expect(text).toContain(buyer.company)
    expect(text).not.toContain("Later live")
    expect(frozen.invoice.balanceDue).toBe(1100)
  })

  it.each(["da-DK", "en-US"])("renders every supported field in PDF, email and public pay in %s", locale => {
    const pdf = normalize(pdfText(InvoicePdfDocument({ invoice, org: { ...seller, locale } })).join(" "))
    const email = normalize(buildInvoiceEmailContent({ invoice: { ...invoice, priceBasis: "net", buyer }, org: { ...seller, locale }, contactName: buyer.name }).html)
    const pay = normalize(renderToStaticMarkup(<LocalizedDocument locale={locale}><PublicInvoicePaymentPage token="synthetic" state={{ kind: "ready", paymentState: "unpaid", stripeEnabled: false, seller: { name: seller.companyName, logo: null }, invoice: {
      ...invoice, id: "synthetic", paymentStatus: "unpaid", totalGross: 1250, subtotalNet: 1000, totalTax: 250, timezone: "Europe/Copenhagen", sellerSnapshot: seller, buyerSnapshot: buyer,
      contact: { name: "Changed live buyer", company: "Changed live company", email: null },
      items: [{ id: "line", description: "Synthetic consulting", quantity: 2, unitPriceNet: 500, unitPriceGross: 625, lineNet: 1000, lineGross: 1250, sortOrder: 0 }],
    } }} /></LocalizedDocument>))
    for (const text of [pdf, email, pay]) {
      for (const field of ["SYNTHETIC-0042", "Synthetic Seller ApS", "CVR: 12345678", "Testvej 1", "Synthetic Buyer", "Synthetic Buyer ApS", "Testvej 2", "1000", "København", "DK", "Synthetic consulting", "2", locale === "da-DK" ? "500,00" : "500.00", locale === "da-DK" ? "1.000,00" : "1,000.00", locale === "da-DK" ? "250,00" : "250.00", locale === "da-DK" ? "1.250,00" : "1,250.00", "25", locale === "da-DK" ? "Leveringsdato" : "Supply Date", locale === "da-DK" ? "Enhedspris ekskl. moms" : "Unit Price excl. tax"]) expect(text).toContain(field)
      expect(text).not.toContain("Changed live")
    }
    expect(pdf).toContain(locale === "da-DK" ? "9. oktober 2026" : "October 9, 2026")
    expect(email).toContain(locale === "da-DK" ? "8. oktober 2026" : "October 8, 2026")
    expect(pay).toContain(locale === "da-DK" ? "8. okt. 2026" : "Oct 8, 2026")
  })
  it("does not invent absent historic supply dates or registration numbers", () => {
    const { supplyDate: _date, ...historic } = invoice
    const text = pdfText(InvoicePdfDocument({ invoice: historic, org: {} })).join(" ")
    expect(text).not.toMatch(/CVR|Supply Date/)
    const email = buildInvoiceEmailContent({ invoice: historic, org: {}, contactName: "" }).html
    expect(email).not.toMatch(/CVR|Supply Date/)
  })
  it.each(["cvr", "dk_cvr", "vat"])("normalizes Danish identifiers stored as %s", scheme => {
    expect(sellerCvr([{ scheme, countryCode: "DK", value: "DK 12 34 56 78" }])).toBe("12345678")
  })
  it("keeps other sellers' existing identifiers without claiming Danish CVR", () => {
    expect(invoiceTaxIds([{ scheme: "vat", countryCode: "SE", value: "SE123456789001" }])).toEqual(["VAT: SE123456789001"])
    expect(sellerCvr([{ scheme: "vat", countryCode: "SE", value: "12345678" }])).toBeNull()
  })
})
