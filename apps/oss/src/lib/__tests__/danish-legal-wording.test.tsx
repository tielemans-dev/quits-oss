// @vitest-environment jsdom

// MOCK: synthetic documents. Every surface renders through the real components and totals builder.
import { isValidElement, type ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { Text } from "@react-pdf/renderer"
import { renderToStaticMarkup } from "react-dom/server"
import { Prisma } from "../../../generated/prisma/client"
import { PublicQuotePage } from "../../components/quotes/public-quote-page"
import { LocalizedDocument } from "../../components/documents/localized-document"
import { composeInvoiceEmail } from "../../domain/documents/invoice-email"
import { buildTotals } from "../documents/totals"
import { CreditNotePdfDocument, type CreditNoteForPdf } from "../credit-note-pdf"
import { InvoicePdfDocument, type InvoiceForPdf } from "../invoice-pdf"

function textOf(node: ReactNode): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return []
  if (typeof node === "string" || typeof node === "number") return [String(node)]
  if (Array.isArray(node)) return node.flatMap(textOf)
  if (isValidElement<{ children?: ReactNode }>(node)) {
    const inner = textOf(node.props.children)
    return node.type === Text ? [inner.join("")] : inner
  }
  return []
}
const flat = (value: string) => value.replace(/<[^>]+>/g, " ").replace(/[  ]/g, " ").replace(/\s+/g, " ")

const ACT = "momslovens § 13"
const reverseDa = "Omvendt betalingspligt – køber afregner momsen (art. 196, direktiv 2006/112/EF)"
const euGoodsDa = "Momsfritaget EU-levering, jf. momslovens § 34, stk. 1, nr. 1 (art. 138, direktiv 2006/112/EF)"

/** One zero-rate row for the given treatment and reason, as `vatRowsByRate` freezes it. */
const zeroRow = (treatment: string, reasonCode: string | null) => ({ ratePercent: "0", net: "1000.00", tax: "0.00", gross: "1000.00", treatment, reasonCode })
const reasonOf = (vatRows: ReturnType<typeof zeroRow>[], locale: string, taxRegime?: string) =>
  buildTotals({ basis: "net", subtotal: "1000.00", taxAmount: "0.00", total: "1000.00", vatRows, currency: "DKK", locale, taxRegime }).lines.find(line => line.kind === "tax")?.reason

describe("Danish VAT statements", () => {
  it.each([
    ["exempt", "health", "momslovens § 13, stk. 1, nr. 1", "section 13(1)(1)"],
    ["exempt", "education", "momslovens § 13, stk. 1, nr. 3", "section 13(1)(3)"],
    ["exempt", "financial", "momslovens § 13, stk. 1", "section 13(1)"],
    ["exempt", "other", "momslovens § 13, stk. 1", "section 13(1)"],
    ["intra_community", "goods", "§ 34, stk. 1, nr. 1 (art. 138", "section 34(1)(1)"],
    ["export", "goods_outside_eu", "§ 34, stk. 1, nr. 5", "section 34(1)(5)"],
  ])("cites the provision for %s / %s in Danish and English", (treatment, reason, da, en) => {
    expect(reasonOf([zeroRow(treatment, reason)], "da-DK")).toContain(da)
    expect(reasonOf([zeroRow(treatment, reason)], "en-US")).toContain(en)
  })

  it("states the reverse charge without naming a provision it cannot cite", () => {
    expect(reasonOf([zeroRow("intra_community", "services_b2b")], "da-DK")).toBe(reverseDa)
    expect(reasonOf([zeroRow("intra_community", "services_b2b")], "en-US")).toBe("Reverse charge – the buyer accounts for the VAT (Art. 196, Directive 2006/112/EC)")
    expect(reasonOf([zeroRow("reverse_charge_domestic", "construction")], "da-DK")).toBe("Omvendt betalingspligt – køber afregner momsen")
  })

  it("keeps the out-of-scope note generic", () => {
    expect(reasonOf([zeroRow("out_of_scope", null)], "da-DK")).toBeTruthy()
    expect(reasonOf([zeroRow("out_of_scope", null)], "da-DK")).not.toContain("§")
  })

  it("prints mixed zero-rate treatments as separate rows, each with its own taxable amount", () => {
    const { lines } = buildTotals({
      basis: "net", subtotal: "3000.00", taxAmount: "250.00", total: "3250.00", currency: "DKK", locale: "da-DK",
      vatRows: [
        { ...zeroRow("exempt", "health"), net: "500.00", gross: "500.00" },
        { ...zeroRow("intra_community", "goods"), net: "1500.00", gross: "1500.00" },
        { ratePercent: "25", net: "1000.00", tax: "250.00", gross: "1250.00", treatment: "standard" },
      ],
    })
    const taxLines = lines.filter(line => line.kind === "tax")
    expect(taxLines.map(line => line.label.replace(/[\u00a0\u202f]/g, " "))).toEqual(["Moms 0 % af 500,00 kr.", "Moms 0 % af 1.500,00 kr.", "Moms 25 % af 1.000,00 kr."])
    expect(taxLines[0]!.reason).toContain(`${ACT}, stk. 1, nr. 1`)
    expect(taxLines[1]!.reason).toBe(euGoodsDa)
    expect(taxLines[2]!.reason).toBeUndefined()
  })

  it("says VAT in English under the EU VAT regime and keeps Tax elsewhere", () => {
    const rows = [{ ratePercent: "25", net: "1000.00", tax: "250.00", gross: "1250.00" }]
    const labels = (taxRegime?: string) => {
      const { lines, total } = buildTotals({ basis: "net", subtotal: "1000.00", taxAmount: "250.00", total: "1250.00", vatRows: rows, currency: "EUR", locale: "en-US", taxRegime })
      return [...lines.map(line => line.label), total.label]
    }
    expect(labels("eu_vat")).toEqual(["Subtotal excl. VAT", "VAT 25%", "Total incl. VAT"])
    expect(labels()).toEqual(["Subtotal excl. tax", "Tax 25%", "Total incl. tax"])
    expect(labels("eu_vat").join(" ")).not.toMatch(/tax/i)
  })
})

describe("Danish legal wording on each surface", () => {
  const invoice: InvoiceForPdf = {
    number: "F-0010", status: "sent", issueDate: "2026-10-05T10:00:00.000Z", dueDate: "2026-11-04T10:00:00.000Z",
    subtotal: 1000, taxAmount: 0, total: 1000, currency: "EUR", notes: null, pricesIncludeTax: false, supplyDate: "2026-10-01",
    vatRows: [zeroRow("intra_community", "goods")], contact: { name: "Kunde GmbH" },
    items: [{ description: "Varer", quantity: 1, unitPrice: 1000, total: 1000 }],
    taxRegime: "eu_vat",
  } as InvoiceForPdf

  it("prints the EU supply statement on the invoice PDF in Danish and English", () => {
    expect(textOf(InvoicePdfDocument({ invoice, org: { locale: "da-DK" } })).join(" ")).toContain(euGoodsDa)
    const en = textOf(InvoicePdfDocument({ invoice, org: { locale: "en-US" } })).join(" ")
    expect(en).toContain("VAT-exempt intra-Community supply under section 34(1)(1) of the Danish VAT Act (Art. 138, Directive 2006/112/EC)")
    expect(en).toContain("VAT 0%")
  })

  it("repeats the statement on a credit note together with the invoice it corrects", () => {
    const credit = {
      number: "K-0003", issueDate: "2026-10-06T10:00:00.000Z", reason: "Returvare", subtotal: 1000, taxAmount: 0, total: 1000,
      currency: "EUR", locale: "da-DK", timezone: "Europe/Copenhagen", invoice: { number: "F-0010", issueDate: "2026-10-05T10:00:00.000Z" },
      contact: { name: "Kunde GmbH" }, pricesIncludeTax: false, vatRows: [zeroRow("intra_community", "goods")], taxRegime: "eu_vat",
      items: [{ description: "Varer", quantity: 1, unitPrice: 1000, total: 1000 }],
    } as CreditNoteForPdf
    const text = textOf(CreditNotePdfDocument({ creditNote: credit })).join(" ")
    expect(text).toContain(euGoodsDa)
    expect(text).toContain("F-0010")
    expect(text).toContain("5. oktober 2026")
  })

  it("puts the statement in the invoice email", () => {
    const D = Prisma.Decimal
    const email = composeInvoiceEmail({
      invoice: {
        id: "d1", number: "F-0010", locale: "da-DK", timezone: "Europe/Copenhagen", currency: "EUR", notes: null, pricesIncludeTax: false, taxRegime: "eu_vat",
        issueDate: new Date("2026-10-05T10:00:00Z"), dueDate: new Date("2026-11-04T10:00:00Z"), expiryDate: new Date("2026-11-04T10:00:00Z"),
        subtotalNet: new D("1000"), totalTax: new D("0"), totalGross: new D("1000"), amountPaid: new D(0), amountCredited: new D(0),
        contact: { name: "Kunde", email: "kunde@example.test" },
        items: [{ description: "Varer", quantity: new D("1"), unitPriceNet: new D("1000"), unitPriceGross: new D("1000"), lineNet: new D("1000"), lineTax: new D("0"), lineGross: new D("1000"), taxRate: new D("0"), vatTreatment: "intra_community", vatReasonCode: "goods", vatCountry: "DE", vatRateInput: "0" }],
      } as never,
      settings: { companyName: "Nordic Design ApS", companyEmail: "finance@nordic.test", locale: "da-DK", timezone: "Europe/Copenhagen", stripePublishableKey: null, stripeSecretKeyEnc: null, stripeWebhookSecretEnc: null } as never,
      to: "kunde@example.test", publicPaymentUrl: null,
    })
    expect(flat(email.message.html ?? "")).toContain(euGoodsDa)
  })

  it("shows the statement on the public quote page", () => {
    const D = (value: number) => ({ toNumber: () => value })
    const quote = {
      id: "quote-1", number: "QTE-0001", status: "sent", issueDate: new Date("2026-03-01T00:00:00.000Z"), expiryDate: new Date("2026-03-15T00:00:00.000Z"),
      totalGross: D(1000), totalTax: D(0), subtotalNet: D(1000), currency: "EUR", timezone: "UTC", notes: null, taxRegime: "eu_vat", pricesIncludeTax: false,
      vatRows: [zeroRow("intra_community", "goods")],
      sellerSnapshot: { companyName: "Acme Studio", companyEmail: "billing@acme.example", companyAddress: "Main Street 1" },
      buyerSnapshot: { name: "Buyer", email: "buyer@example.com", company: "Buyer GmbH" },
      publicDecisionAt: null, publicRejectionReason: null, contact: { name: "Buyer", email: "buyer@example.com", company: "Buyer GmbH" },
      items: [{ id: "item-1", description: "Goods", quantity: D(1), unitPriceNet: D(1000), lineNet: D(1000), unitPriceGross: D(1000), lineGross: D(1000), sortOrder: 0 }],
      invoices: [],
    }
    const render = (locale: string) => flat(renderToStaticMarkup(
      <LocalizedDocument locale={locale}><PublicQuotePage token="t" state={{ kind: "ready", decisionState: "pending", seller: { name: "Acme Studio", logo: null }, quote } as never} /></LocalizedDocument>,
    ))
    expect(render("da-DK")).toContain(euGoodsDa)
    expect(render("en-US")).toContain("VAT-exempt intra-Community supply under section 34(1)(1) of the Danish VAT Act (Art. 138, Directive 2006/112/EC)")
  })
})
