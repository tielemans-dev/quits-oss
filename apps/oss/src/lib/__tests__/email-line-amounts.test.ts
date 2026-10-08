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
  { description: "Rådgivning", quantity: new D("2"), unitPriceNet: new D("4000"), unitPriceGross: new D("5000"), lineNet: new D("8000"), lineGross: new D("10000") },
  { description: "Licens", quantity: new D("1"), unitPriceNet: new D("6500"), unitPriceGross: new D("8125"), lineNet: new D("6500"), lineGross: new D("8125") },
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
    expect(html).toContain("Pris ekskl. moms")
    expect(html).toContain("Beløb ekskl. moms")
    expect(html).toContain("Rådgivning 2 4.000,00 kr. 8.000,00 kr.")
    expect(html).toContain("Licens 1 6.500,00 kr. 6.500,00 kr.")
    expect(html).not.toContain("10.000,00 kr.")
  })

  it("list gross lines under gross headers when the invoice's prices include VAT", () => {
    const html = text(composeInvoiceEmail({ invoice: { ...document, pricesIncludeTax: true }, settings, to: "kunde@example.test", publicPaymentUrl: null }).message.html ?? "")
    expect(html).toContain("Pris inkl. moms")
    expect(html).toContain("Beløb inkl. moms")
    expect(html).toContain("Rådgivning 2 5.000,00 kr. 10.000,00 kr.")
    expect(html).toContain("Licens 1 8.125,00 kr. 8.125,00 kr.")
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
