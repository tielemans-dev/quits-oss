// MOCK: synthetic test organizations, parties, document amounts and rates only.
import { isValidElement, type ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { Text } from "@react-pdf/renderer"
import { renderToStaticMarkup } from "react-dom/server"
import { InvoicePdfDocument, type InvoiceForPdf } from "../invoice-pdf"
import { buildInvoiceEmailContent, buildQuoteEmailContent } from "../email"
import { LocalizedDocument } from "../../components/documents/localized-document"
import { PublicInvoicePaymentPage } from "../../components/invoices/public-invoice-payment-page"
import { CreditNotePdfDocument, type CreditNoteForPdf } from "../credit-note-pdf"
import { buildCreditNoteEmailContent } from "../emails/credit-note-email"
import { translate } from "../i18n/translate"
import { formatCurrency } from "../i18n/format"
import { nonVatStatement } from "../documents/non-vat-note"
import { withoutNonVatStatement } from "../documents/non-vat-presentation"
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
function outputs(locale: string, momsRegistered?: boolean | null, overrides: Partial<InvoiceForPdf> = {}) {
  const taxRate = momsRegistered ? 25 : 0
  const document = { ...invoice, momsRegistered, taxAmount: taxRate, total: 100 + taxRate, items: [{ ...invoice.items[0]!, taxRate }], ...overrides }
  return [
    pdfText(InvoicePdfDocument({ invoice: document, org: { locale } })).join(" "),
    buildInvoiceEmailContent({ invoice: { ...document, priceBasis: "net" }, org: { locale }, contactName: "Synthetic buyer", publicPaymentUrl: "https://example.test/pay/test" }).html,
    renderToStaticMarkup(<LocalizedDocument locale={locale}><PublicInvoicePaymentPage token="synthetic" state={{ kind: "ready", paymentState: "unpaid", stripeEnabled: false, seller: { name: "Synthetic seller", logo: null }, invoice: {
      ...document, id: "synthetic", timezone: "Europe/Copenhagen", paymentStatus: "unpaid", subtotalNet: document.subtotal, totalTax: document.taxAmount, totalGross: document.total, buyerSnapshot: null,
      sellerSnapshot: { momsRegistered, bankAccount: invoice.bankAccount, paymentNote: document.paymentNote }, contact: { name: "Synthetic buyer", email: null, company: null },
      items: [{ id: "synthetic-line", description: "Synthetic service", quantity: 1, unitPriceNet: 100, unitPriceGross: 100, lineNet: 100, lineGross: 100, sortOrder: 0, taxRate: document.items[0]!.taxRate ?? 0 }],
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
  it.each(["custom", "us_sales_tax"])("preserves 25 percent custom tax without VAT-specific presentation under %s", taxRegime => {
    for (const output of outputs("en-US", false, { taxRegime, notes: `Synthetic instructions\n${nonVatStatement("en")}`, paymentNote: `Synthetic transfer instructions\n${nonVatStatement("en")}`, taxAmount: 25, total: 125,
      vatRows: [{ ratePercent: "25", net: "100", tax: "25", gross: "125" }],
      items: [{ ...invoice.items[0]!, taxRate: 25 }] }).concat(buildQuoteEmailContent({
        quote: { number: "Synthetic quote", issueDate: invoice.issueDate, expiryDate: "2099-12-01", subtotal: 100, taxAmount: 25, total: 125, currency: "DKK", momsRegistered: false, taxRegime, items: [{ ...invoice.items[0]!, taxRate: 25 }] },
        org: { locale: "en-US" }, contactName: "Synthetic buyer",
      }).html)) {
      expect(output).not.toMatch(/25 % moms|No moms|Ingen moms|The company is not VAT registered/)
      expect(output).toContain(formatCurrency(125, "DKK", "en-US"))
      expect(output).toContain(formatCurrency(25, "DKK", "en-US"))
    }
    const creditNote = { ...credit, taxRegime, sellerSnapshot: { momsRegistered: false }, taxAmount: 25, total: 125,
      items: [{ ...credit.items[0]!, taxRate: 25 }] }
    const pdf = pdfText(CreditNotePdfDocument({ creditNote, org: { locale: "en-US" } })).join(" ")
    const email = buildCreditNoteEmailContent({ creditNote, invoice: credit.invoice, org: { locale: "en-US" }, contactName: "Synthetic buyer" }).html
    for (const output of [pdf, email]) {
      expect(output).not.toMatch(/25 % moms|The company is not VAT registered/)
      expect(output).toContain(formatCurrency(125, "DKK", "en-US"))
    }
  })
  it("does not label other registered rates as 25 %%", () => {
    expect(sellerVatLineText(true, 20, "en-US")).toBeNull()
  })
  it.each(["da-DK", "en-US"])("never labels a stored 25 %% line as no VAT in %s", locale => {
    for (const output of outputs(locale, false, { taxAmount: 25, total: 125, vatRows: [{ ratePercent: "25", net: "100", tax: "25", gross: "125" }], items: [{ ...invoice.items[0]!, taxRate: 25 }] })) {
      expect(output).toContain("25 % moms")
      expect(output).toContain(formatCurrency(125, "DKK", locale))
      expect(output).toContain(translate("pdf.taxRate", locale, { rate: "25" }))
      expect(output).not.toMatch(/Ingen moms|No moms/)
    }
    expect(sellerVatLineText(false, undefined, locale)).toBeNull()
    expect(sellerVatLineText(false, 20, locale)).toBeNull()
  })
  it.each(["da-DK", "en-US"])("prints one localized statement across generated and custom note surfaces in %s", locale => {
    const note = nonVatStatement(locale)
    const other = nonVatStatement(locale === "da-DK" ? "en" : "da")
    for (const output of outputs(locale, false, {
      paymentNote: `Synthetic payment instructions\n${other}\n${note}`,
      notes: `Synthetic document instructions\n${note}\n${note}`,
    })) {
      expect(output.split(note)).toHaveLength(2)
      expect(output).not.toContain(other)
    }
    const [pdf, email, pay] = outputs(locale, false, { paymentNote: `Synthetic payment instructions\n${note}`, notes: `Synthetic document instructions\n${note}` })
    expect(pdf).toContain("Synthetic payment instructions")
    expect(pay).toContain("Synthetic payment instructions")
    expect(pdf).toContain("Synthetic document instructions")
    expect(email).toContain("Synthetic document instructions")
  })
  it.each(["da-DK", "en-US"])("keeps a non-registered zero VAT document without a VAT breakdown in %s", locale => {
    for (const output of outputs(locale, false, { vatRows: [{ ratePercent: "0", net: "100", tax: "0", gross: "100" }] })) {
      expect(output).not.toContain(translate("pdf.taxRate", locale, { rate: "0" }))
      expect(output).not.toContain("25 % moms")
      expect(output).toContain(formatCurrency(100, "DKK", locale))
      expect(output).toContain(nonVatStatement(locale))
    }
  })
  it.each([null, undefined, true])("preserves legacy and registered custom notes verbatim: %s", status => {
    const note = `Synthetic instructions\n${nonVatStatement("da")}\n${nonVatStatement("en")}`
    expect(withoutNonVatStatement(note, status)).toBe(note)
  })
})

const credit: CreditNoteForPdf = {
  number: "SYNTHETIC-CN-0042", issueDate: invoice.issueDate, reason: "Synthetic correction",
  subtotal: 100, taxAmount: 0, total: 100, currency: "DKK", contact: invoice.contact,
  invoice: { number: invoice.number, issueDate: invoice.issueDate }, items: invoice.items,
}
describe("credit note registration statement", () => {
  it.each(["da-DK", "en-US"])("prints the issued choice once in PDF and email in %s", locale => {
    const note = nonVatStatement(locale)
    const document = { ...credit, locale, sellerSnapshot: { companyName: "Frozen synthetic seller", momsRegistered: false }, reason: `${credit.reason}\n${nonVatStatement("da")}\n${nonVatStatement("en")}` }
    const pdf = pdfText(CreditNotePdfDocument({ creditNote: document, org: { locale, companyName: "Changed synthetic seller" } })).join(" ")
    const email = buildCreditNoteEmailContent({ creditNote: document, invoice: credit.invoice, org: { locale }, contactName: "Synthetic buyer" }).html
    for (const output of [pdf, email]) {
      expect(output.split(note)).toHaveLength(2)
      expect(output).toContain(credit.reason)
      expect(output).toContain(translate("line.noVat", locale))
      expect(output).not.toContain(nonVatStatement(locale === "da-DK" ? "en" : "da"))
    }
    expect(pdf).toContain("Frozen synthetic seller")
    expect(pdf).not.toContain("Changed synthetic seller")
  })
  it.each([null, undefined, {}, { momsRegistered: null }, { momsRegistered: true }])("does not infer non-registration for a credit snapshot %s", sellerSnapshot => {
    const document = { ...credit, sellerSnapshot }
    const pdf = pdfText(CreditNotePdfDocument({ creditNote: document, org: { locale: "en-US" } })).join(" ")
    const email = buildCreditNoteEmailContent({ creditNote: document, invoice: credit.invoice, org: { locale: "en-US" }, contactName: "Synthetic buyer" }).html
    for (const output of [pdf, email]) expect(output).not.toContain(nonVatStatement("en"))
  })
})
