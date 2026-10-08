import { isValidElement, type ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { Text, renderToBuffer } from "@react-pdf/renderer"
import { InvoicePdfDocument, type InvoiceForPdf } from "../invoice-pdf"
import { CreditNotePdfDocument, type CreditNoteForPdf } from "../credit-note-pdf"

/** The text of a react-pdf element tree, one entry per `Text` element, in document order. */
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

const nbsp = (text: string) => text.replace(/[  ]/g, " ")
const invoiceText = (invoice: InvoiceForPdf, org: { locale: string; timezone?: string }) =>
  textOf(InvoicePdfDocument({ invoice, org })).map(nbsp)
const creditText = (creditNote: CreditNoteForPdf) => textOf(CreditNotePdfDocument({ creditNote })).map(nbsp)

/** The Danish example: 2 x 4.000,00 and 1 x 6.500,00 excluding 25 % VAT. */
const danish: InvoiceForPdf = {
  number: "F-0007",
  status: "sent",
  issueDate: "2026-10-05T10:00:00.000Z",
  dueDate: "2026-11-04T10:00:00.000Z",
  subtotal: 14500,
  taxAmount: 3625,
  total: 18125,
  currency: "DKK",
  notes: null,
  pricesIncludeTax: false,
  supplyDate: "2026-10-01",
  vatRows: [{ ratePercent: "25", net: "14500.00", tax: "3625.00", gross: "18125.00" }],
  contact: { name: "Kunde A/S" },
  items: [
    { description: "Rådgivning", quantity: 2, unitPrice: 4000, total: 8000 },
    { description: "Licens", quantity: 1, unitPrice: 6500, total: 6500 },
  ],
}

describe("invoice PDF lines", () => {
  it("prints net unit prices and amounts that add up to the subtotal when prices exclude VAT", () => {
    const text = invoiceText(danish, { locale: "da-DK" })
    expect(text).toContain("Pris ekskl. moms")
    expect(text).toContain("Beløb ekskl. moms")
    expect(text).toEqual(expect.arrayContaining(["4.000,00 kr.", "8.000,00 kr.", "6.500,00 kr."]))
    expect(text).not.toContain("10.000,00 kr.")
    expect(text).not.toContain("8.125,00 kr.")
    expect(text).toEqual(expect.arrayContaining(["Subtotal", "14.500,00 kr.", "Moms (25 %)", "3.625,00 kr.", "18.125,00 kr."]))
  })

  it("names a gross basis in the headers", () => {
    const text = invoiceText({ ...danish, pricesIncludeTax: true }, { locale: "da-DK" })
    expect(text).toContain("Pris inkl. moms")
    expect(text).toContain("Beløb inkl. moms")
  })

  it("speaks English for an English organization", () => {
    const text = invoiceText({ ...danish, currency: "USD", vatRows: [{ ratePercent: "10", net: "1.00", tax: "0.10", gross: "1.10" }] }, { locale: "en-US" })
    expect(text).toContain("Unit Price excl. tax")
    expect(text).toContain("Amount excl. tax")
    expect(text).toContain("Tax (10%)")
    expect(text).toContain("Supply Date")
  })

  it("keeps the plain headers for a render input frozen before documents stated their basis", () => {
    const { pricesIncludeTax: _basis, supplyDate: _supply, vatRows: _rows, ...legacy } = danish
    const text = invoiceText(legacy, { locale: "da-DK" })
    expect(text).toContain("Enhedspris")
    expect(text).not.toContain("Pris ekskl. moms")
    expect(text).toEqual(expect.arrayContaining(["Moms", "3.625,00 kr."]))
    expect(text).not.toContain("Leveringsdato")
  })

  it("prints one VAT row per rate, in the order given, with the total after them", () => {
    const text = invoiceText({
      ...danish,
      subtotal: 1201,
      taxAmount: 310.05,
      total: 1511.05,
      vatRows: [
        { ratePercent: "0", net: "500.00", tax: "0.00", gross: "500.00" },
        { ratePercent: "5", net: "201.00", tax: "10.05", gross: "211.05" },
        { ratePercent: "25", net: "1200.00", tax: "300.00", gross: "1500.00" },
      ],
    }, { locale: "da-DK" })
    const labels = text.filter((entry) => entry.startsWith("Moms ("))
    expect(labels).toEqual(["Moms (0 %)", "Moms (5 %)", "Moms (25 %)"])
    expect(text.indexOf("Moms (25 %)")).toBeLessThan(text.lastIndexOf("Total"))
  })

  it("prints no VAT row for a document without VAT", () => {
    const text = invoiceText({ ...danish, taxAmount: 0, vatRows: [{ ratePercent: "0", net: "14500.00", tax: "0.00", gross: "14500.00" }] }, { locale: "da-DK" })
    expect(text.filter((entry) => entry.startsWith("Moms"))).toEqual([])
  })

  it("prints the supply date as a calendar date in any time zone", () => {
    for (const timezone of ["Pacific/Honolulu", "UTC", "Pacific/Auckland"]) {
      const text = invoiceText(danish, { locale: "da-DK", timezone })
      const label = text.indexOf("Leveringsdato")
      expect(label).toBeGreaterThan(-1)
      expect(text[label + 1]).toBe("1. oktober 2026")
    }
  })

  it("leaves the supply date out when the invoice has none", () => {
    const { supplyDate: _supply, ...withoutSupplyDate } = danish
    expect(invoiceText(withoutSupplyDate, { locale: "da-DK" })).not.toContain("Leveringsdato")
  })

  it("renders to a PDF", async () => {
    const buffer = await renderToBuffer(InvoicePdfDocument({ invoice: danish, org: { locale: "da-DK", companyName: "Nordic Design ApS" } }))
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-")
  })
})

describe("credit note PDF lines", () => {
  const credit: CreditNoteForPdf = {
    number: "K-0001",
    issueDate: "2026-10-06T10:00:00.000Z",
    reason: "Returvare",
    subtotal: 6500,
    taxAmount: 1625,
    total: 8125,
    currency: "DKK",
    locale: "da-DK",
    timezone: "Europe/Copenhagen",
    invoice: { number: "F-0007", issueDate: "2026-10-05T10:00:00.000Z" },
    contact: { name: "Kunde A/S" },
    pricesIncludeTax: false,
    vatRows: [{ ratePercent: "25", net: "6500.00", tax: "1625.00", gross: "8125.00" }],
    items: [{ description: "Licens", quantity: 1, unitPrice: 6500, total: 6500 }],
  }

  it("mirrors the net basis of the invoice it credits", () => {
    const text = creditText(credit)
    expect(text).toContain("Pris ekskl. moms")
    expect(text).toContain("Beløb ekskl. moms")
    expect(text).toEqual(expect.arrayContaining(["Moms (25 %)", "1.625,00 kr.", "8.125,00 kr."]))
  })

  it("mirrors a gross basis", () => {
    const text = creditText({ ...credit, pricesIncludeTax: true, items: [{ description: "Licens", quantity: 1, unitPrice: 8125, total: 8125 }] })
    expect(text).toContain("Pris inkl. moms")
    expect(text).toContain("Beløb inkl. moms")
  })

  it("keeps the plain headers for a render input frozen before credit notes stated their basis", () => {
    const { pricesIncludeTax: _basis, vatRows: _rows, ...legacy } = credit
    const text = creditText(legacy)
    expect(text).toContain("Enhedspris")
    expect(text).toContain("Moms")
  })

  it("renders to a PDF", async () => {
    const buffer = await renderToBuffer(CreditNotePdfDocument({ creditNote: credit }))
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-")
  })
})
