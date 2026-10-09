import { describe, expect, it } from "vitest"
import { Prisma } from "../../../generated/prisma/client"
import { composeInvoiceEmail } from "../../domain/documents/invoice-email"
import { composeQuoteEmail } from "../../domain/documents/quote-email"
import { buildCreditNoteEmailContent } from "../emails/credit-note-email"

const D = Prisma.Decimal
const settings = {
  companyName: "Nordic Design ApS", companyEmail: "finance@nordic.test", locale: "da-DK", timezone: "Europe/Copenhagen",
  stripePublishableKey: null, stripeSecretKeyEnc: null, stripeWebhookSecretEnc: null,
} as never
/** Two lines, 4.000,00 net x 2 and 6.500,00 net x 1 at 25 %: the example of the bug. */
const lines = [
  { description: "Rådgivning", quantity: new D("2"), unitPriceNet: new D("4000"), unitPriceGross: new D("5000"), lineNet: new D("8000"), lineTax: new D("2000"), lineGross: new D("10000"), taxRate: new D("25"), vatTreatment: "standard", vatReasonCode: null, vatCountry: null, vatRateInput: "0.25" },
  { description: "Licens", quantity: new D("1"), unitPriceNet: new D("6500"), unitPriceGross: new D("8125"), lineNet: new D("6500"), lineTax: new D("1625"), lineGross: new D("8125"), taxRate: new D("25"), vatTreatment: "standard", vatReasonCode: null, vatCountry: null, vatRateInput: "0.25" },
]
const document = {
  id: "d1", number: "F-0007", locale: "da-DK", timezone: "Europe/Copenhagen", currency: "DKK", notes: null,
  issueDate: new Date("2026-10-05T10:00:00Z"), dueDate: new Date("2026-11-04T10:00:00Z"), expiryDate: new Date("2026-11-04T10:00:00Z"),
  subtotalNet: new D("14500"), totalTax: new D("3625"), totalGross: new D("18125"),
  contact: { name: "Kunde", email: "kunde@example.test" }, items: lines,
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/[  ]/g, " ").replace(/\s+/g, " ")

describe("document emails", () => {
  it("list net lines under net headers when the invoice's prices exclude VAT", () => {
    const html = text(composeInvoiceEmail({ invoice: { ...document, pricesIncludeTax: false }, settings, to: "kunde@example.test", publicPaymentUrl: null }).message.html ?? "")
    expect(html).toContain("Enhedspris ekskl. moms")
    expect(html).toContain("Beløb ekskl. moms")
    expect(html).toContain("Rådgivning 2 4.000,00 kr. 8.000,00 kr.")
    expect(html).toContain("Licens 1 6.500,00 kr. 6.500,00 kr.")
    expect(html).not.toContain("10.000,00 kr.")
  })

  it("list stored net prices even when invoice entry prices include VAT", () => {
    const html = text(composeInvoiceEmail({ invoice: { ...document, pricesIncludeTax: true }, settings, to: "kunde@example.test", publicPaymentUrl: null }).message.html ?? "")
    expect(html).toContain("Enhedspris ekskl. moms")
    expect(html).toContain("Beløb ekskl. moms")
    expect(html).toContain("Rådgivning 2 4.000,00 kr. 8.000,00 kr.")
    expect(html).toContain("Licens 1 6.500,00 kr. 6.500,00 kr.")
  })

  it("print the VAT row with its rate on a net invoice, and no rounding", () => {
    const html = text(composeInvoiceEmail({ invoice: { ...document, pricesIncludeTax: false }, settings, to: "kunde@example.test", publicPaymentUrl: null }).message.html ?? "")
    expect(html).toContain("Subtotal 14.500,00 kr. Moms (25 %) 3.625,00 kr. Total 18.125,00 kr.")
  })

  it("print the rounding between the tax and the total of a gross invoice", () => {
    // 10,12 kr including 25 % VAT: net 8,10 plus tax 2,03 is a cent over the total.
    const gross = { ...document, pricesIncludeTax: true, subtotalNet: new D("8.10"), totalTax: new D("2.03"), totalGross: new D("10.12"),
      items: [{ ...lines[0]!, quantity: new D("1"), unitPriceNet: new D("8.10"), unitPriceGross: new D("10.12"), lineNet: new D("8.10"), lineTax: new D("2.03"), lineGross: new D("10.12") }] }
    for (const html of [
      text(composeInvoiceEmail({ invoice: gross, settings, to: "kunde@example.test", publicPaymentUrl: null }).message.html ?? ""),
      text(composeQuoteEmail({ quote: gross, settings, to: "kunde@example.test", publicQuoteUrl: null }).message.html ?? ""),
    ]) {
      expect(html).toMatch(/Subtotal(?: ekskl. moms)? 8,10 kr. Moms \(25 %\) 2,03 kr. Afrunding -0,01 kr. Total(?: inkl. moms)? 10,12 kr./)
    }
  })

  it("name each rate's taxable amount when an invoice has several", () => {
    const mixed = { ...document, pricesIncludeTax: false, subtotalNet: new D("16500"), totalTax: new D("2000"), totalGross: new D("18500"),
      items: [lines[0]!, { ...lines[1]!, lineNet: new D("8500"), lineTax: new D("0"), lineGross: new D("8500"), vatTreatment: "exempt", vatReasonCode: "other", taxRate: new D("0"), vatRateInput: "0" }] }
    const html = text(composeInvoiceEmail({ invoice: mixed, settings, to: "kunde@example.test", publicPaymentUrl: null }).message.html ?? "")
    expect(html).toContain("Moms 0 % af 8.500,00 kr. 0,00 kr. Moms 25 % af 8.000,00 kr. 2.000,00 kr.")
  })

  it("do the same for a quote", () => {
    const html = text(composeQuoteEmail({ quote: { ...document, pricesIncludeTax: false }, settings, to: "kunde@example.test", publicQuoteUrl: null }).message.html ?? "")
    expect(html).toContain("Beløb ekskl. moms")
    expect(html).not.toContain("10.000,00 kr.")
  })

  it("keep the plain headers for a credit note that names no basis", () => {
    const content = buildCreditNoteEmailContent({
      creditNote: { number: "K-1", issueDate: "2026-10-06", reason: "x", subtotal: 1, taxAmount: 0, total: 1, currency: "DKK", items: [] },
      invoice: { number: "F-1", issueDate: "2026-10-05" },
      org: { locale: "da-DK" }, contactName: "Kunde",
    } as never)
    expect(text(content.html)).toContain("Enhedspris")
    const net = buildCreditNoteEmailContent({
      creditNote: { number: "K-1", issueDate: "2026-10-06", reason: "x", subtotal: 1, taxAmount: 0, total: 1, currency: "DKK", priceBasis: "net", items: [] },
      invoice: { number: "F-1", issueDate: "2026-10-05" },
      org: { locale: "da-DK" }, contactName: "Kunde",
    } as never)
    expect(text(net.html)).toContain("Beløb ekskl. moms")
  })
})
