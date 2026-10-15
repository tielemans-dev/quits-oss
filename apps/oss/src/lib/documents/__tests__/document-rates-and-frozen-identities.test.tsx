import { isValidElement, type ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { Text } from "@react-pdf/renderer"
import { InvoicePdfDocument, type InvoiceForPdf } from "../../invoice-pdf"
import { buildInvoiceEmailContent } from "../../email"
import { serializePublicInvoiceSession } from "../../payments/public-session"
import { serializePublicQuoteSession } from "../../quotes/public-session"
import { vatRowsByRate } from "../../../domain/documents/frozen-vat-groups"
import { buildTotals } from "../totals"
import { creditMoneySnapshot } from "../../../domain/documents/money-snapshot"
import { nominalLineTaxRate } from "../line-amounts"

const decimal = (value: number) => ({ toNumber: () => value })
const text = (node: ReactNode): string[] => {
  if (node == null || typeof node === "boolean") return []
  if (typeof node === "string" || typeof node === "number") return [String(node)]
  if (Array.isArray(node)) return node.flatMap(text)
  if (isValidElement<{ children?: ReactNode }>(node)) { const children = text(node.props.children); return node.type === Text ? [children.join("")] : children }
  return []
}
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

describe("Document rates and frozen identities", () => {
  it("keeps zero-rate reason codes on printable rows, distinct per reason", () => {
    const rows = vatRowsByRate(["health", "education"].map(reasonCode => ({ rate: "0", net: "10", tax: "0", gross: "10", treatment: "exempt", reasonCode })), "DKK")
    expect(rows.map(row => row.reasonCodes)).toEqual([["health"], ["education"]])
    const result = buildTotals({ basis: "net", subtotal: "20", taxAmount: "0", total: "20", currency: "DKK", locale: "en-US", vatRows: rows })
    expect(result.lines[1]?.reason).toBe("Exempt · Health")
    expect(result.lines[2]?.reason).toBe("Exempt · Education")
  })

  it("derives the nominal document rate from line order, not from totals", () => {
    expect(nominalLineTaxRate([25, 5])).toBe(25)
    expect(nominalLineTaxRate([0, 5, 25])).toBe(5)
    expect(nominalLineTaxRate([0, 0])).toBe(0)
    expect(nominalLineTaxRate([undefined])).toBeUndefined()
  })

  it("serializes public invoice and quote rates from persisted items", () => {
    const items = [
      { id: "b", description: "Reduced", quantity: decimal(1), unitPriceNet: decimal(100), lineNet: decimal(100), unitPriceGross: decimal(105), lineGross: decimal(105), taxRate: decimal(5), sortOrder: 1 },
      { id: "a", description: "Standard", quantity: decimal(1), unitPriceNet: decimal(100), lineNet: decimal(100), unitPriceGross: decimal(125), lineGross: decimal(125), taxRate: decimal(25), sortOrder: 0 },
    ]
    const invoice = serializePublicInvoiceSession({ paymentState: "unpaid", stripeEnabled: false, invoice: {
      id: "i", number: "INV-1", status: "sent", paymentStatus: "unpaid", issueDate: "2026-03-09", dueDate: "2026-03-23",
      totalGross: decimal(230), amountPaid: decimal(0), amountCredited: decimal(0), totalTax: decimal(30), subtotalNet: decimal(200), currency: "DKK",
      notes: null, sellerSnapshot: null, buyerSnapshot: null, contact: { name: "K", email: null, company: null }, items,
    } }, "t")
    expect(invoice.invoice.taxRate).toBe(25)
    const quote = serializePublicQuoteSession({ decisionState: "pending", quote: {
      id: "q", number: "QTE-1", status: "sent", issueDate: "2026-03-09", expiryDate: "2026-03-23", totalGross: decimal(230), totalTax: decimal(30), subtotalNet: decimal(200),
      currency: "DKK", notes: null, sellerSnapshot: null, buyerSnapshot: null, publicDecisionAt: null, publicRejectionReason: null, contact: { name: "K", email: null, company: null },
      items: items.map(item => ({ ...item, vatTreatment: "standard" })), invoices: [],
    } } as never, "t")
    expect(quote.quote.taxRate).toBe(25)
  })

  it("labels deviating line VAT rates in document emails", () => {
    const vatRows = [{ ratePercent: "5.5", net: "100", tax: "5.5", gross: "105.5" }, { ratePercent: "25", net: "100", tax: "25", gross: "125" }]
    const { html } = buildInvoiceEmailContent({
      invoice: { number: "INV-1", issueDate: "2026-03-09", dueDate: "2026-03-23", subtotal: 200, taxAmount: 30.5, total: 230.5, currency: "DKK", priceBasis: "net", vatRows,
        items: [{ description: "Standard", quantity: 1, unitPrice: 100, total: 100, taxRate: 25 }, { description: "Reduced", quantity: 1, unitPrice: 100, total: 100, taxRate: 5.5 }] },
      org: { companyName: "Seller", locale: "da-DK" }, contactName: "Buyer",
    })
    const rows = html.split("<tr>").filter(row => row.includes("Standard") || row.includes("Reduced"))
    expect(plain(rows.find(row => row.includes("Reduced"))!)).toContain("5,5 % moms")
    expect(plain(rows.find(row => row.includes("Standard"))!)).not.toContain("% moms")
  })

  it("uses the buyer country for the invoice PDF footer seller IDs, as for the header", () => {
    const seller = { companyName: "Seller ApS", taxIds: [{ scheme: "vat", value: "DK12345678", countryCode: "DK" }], locale: "en-US" }
    const invoice = { number: "INV-1", status: "sent", issueDate: "2026-03-09T12:00:00Z", dueDate: "2026-03-23", subtotal: 100, taxAmount: 0, total: 100, currency: "DKK", notes: null, pricesIncludeTax: false, momsRegistered: true,
      contact: { name: "Buyer", country: "SE" }, items: [{ description: "Service", quantity: 1, unitPrice: 100, total: 100 }] } as InvoiceForPdf
    const output = text(InvoicePdfDocument({ invoice, org: seller })).join("\n")
    expect(output.match(/VAT no\. DK12345678/g)).toHaveLength(2)
    expect(output).not.toContain("CVR no.")
  })

  it("freezes the main rate from credited line order, including [5, 25]", () => {
    for (const rates of [[5], [5, 25]]) {
      const snapshot = creditMoneySnapshot({ currency: "DKK", totalGross: "1000", issuanceSnapshot: null } as never, {
        id: "credit", number: "CN-1", issuedAt: new Date("2026-10-15"), baseCurrency: "DKK", reason: "Correction", mode: "lines",
        built: { lines: rates.map(taxRate => ({ taxRate, lineNet: 100, lineTax: taxRate, lineGross: 100 + taxRate })), subtotalNet: 100, totalTax: 5, totalGross: 105 } as never,
        hasPayments: false, paid: "0", priorCredits: "0", seller: {}, buyer: {},
      })
      expect(snapshot.taxRate).toBe(5)
    }
  })
})
