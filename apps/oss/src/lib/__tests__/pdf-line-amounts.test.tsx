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
    expect(text).toContain("Enhedspris ekskl. moms")
    expect(text).toContain("Beløb ekskl. moms")
    expect(text).toEqual(expect.arrayContaining(["4.000,00 kr.", "8.000,00 kr.", "6.500,00 kr."]))
    expect(text).not.toContain("10.000,00 kr.")
    expect(text).not.toContain("8.125,00 kr.")
    expect(text).toEqual(expect.arrayContaining(["Subtotal", "14.500,00 kr.", "Moms (25 %)", "3.625,00 kr.", "18.125,00 kr."]))
  })

  it("names a gross basis in the headers", () => {
    const text = invoiceText({ ...danish, pricesIncludeTax: true }, { locale: "da-DK" })
    expect(text).toContain("Enhedspris inkl. moms")
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
    expect(text).not.toContain("Enhedspris ekskl. moms")
    expect(text).toEqual(expect.arrayContaining(["Moms", "3.625,00 kr."]))
    expect(text).not.toContain("Leveringsdato")
  })

  it("prints one VAT row per rate, each with its taxable amount, and the total after them", () => {
    const text = invoiceText({
      ...danish,
      subtotal: 1901,
      taxAmount: 310.05,
      total: 2211.05,
      items: [
        { description: "Kursus", quantity: 1, unitPrice: 500, total: 500 },
        { description: "Rådgivning", quantity: 2, unitPrice: 100.5, total: 201 },
        { description: "Licens", quantity: 1, unitPrice: 1200, total: 1200 },
      ],
      vatRows: [
        { ratePercent: "0", net: "500.00", tax: "0.00", gross: "500.00" },
        { ratePercent: "5", net: "201.00", tax: "10.05", gross: "211.05" },
        { ratePercent: "25", net: "1200.00", tax: "300.00", gross: "1500.00" },
      ],
    }, { locale: "da-DK" })
    const labels = text.filter((entry) => entry.startsWith("Moms "))
    expect(labels).toEqual(["Moms 0 % af 500,00 kr.", "Moms 5 % af 201,00 kr.", "Moms 25 % af 1.200,00 kr."])
    expect(text.indexOf("Moms 25 % af 1.200,00 kr.")).toBeLessThan(text.lastIndexOf("Total"))
  })

  it("falls back to the single tax amount when the rows are empty", () => {
    const text = invoiceText({ ...danish, vatRows: [] }, { locale: "da-DK" })
    expect(text).toEqual(expect.arrayContaining(["Moms", "3.625,00 kr."]))
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

describe("invoice PDF totals", () => {
  /** 10,12 kr including 25 % VAT: net 8,10 and tax 2,03 round to 10,13, a cent over the total. */
  const rounded: InvoiceForPdf = {
    ...danish,
    subtotal: 8.1,
    taxAmount: 2.03,
    total: 10.12,
    pricesIncludeTax: true,
    rounding: "-0.01",
    vatRows: [{ ratePercent: "25", net: "8.10", tax: "2.03", gross: "10.12" }],
    items: [{ description: "Vare", quantity: 1, unitPrice: 10.12, total: 10.12 }],
  }

  it("prints the rounding between the VAT and the total so the rows add up", () => {
    const text = invoiceText(rounded, { locale: "da-DK" })
    const subtotal = text.indexOf("Subtotal ekskl. moms")
    expect(text.slice(subtotal, subtotal + 8)).toEqual(["Subtotal ekskl. moms", "8,10 kr.", "Moms (25 %)", "2,03 kr.", "Afrunding", "-0,01 kr.", "Total inkl. moms", "10,12 kr."])
  })

  it("prints no rounding row when there is none", () => {
    expect(invoiceText({ ...rounded, rounding: "0.00" }, { locale: "da-DK" })).not.toContain("Afrunding")
    expect(invoiceText({ ...danish, rounding: "0.00" }, { locale: "da-DK" })).not.toContain("Afrunding")
  })

  it("labels the subtotal and total of a gross document, and leaves a net document's plain", () => {
    const gross = invoiceText(rounded, { locale: "da-DK" })
    expect(gross).toEqual(expect.arrayContaining(["Subtotal ekskl. moms", "Total inkl. moms"]))
    const net = invoiceText(danish, { locale: "da-DK" })
    expect(net).toEqual(expect.arrayContaining(["Subtotal", "Total"]))
    expect(net).not.toContain("Total inkl. moms")
    const english = invoiceText({ ...rounded, currency: "USD" }, { locale: "en-US" })
    expect(english).toEqual(expect.arrayContaining(["Subtotal excl. tax", "Rounding", "Total incl. tax"]))
  })

  it("names each rate's taxable amount in English when there are several", () => {
    const text = invoiceText({
      ...danish, currency: "USD",
      vatRows: [{ ratePercent: "5", net: "201.00", tax: "10.05", gross: "211.05" }, { ratePercent: "10", net: "100.00", tax: "10.00", gross: "110.00" }],
    }, { locale: "en-US" })
    expect(text).toEqual(expect.arrayContaining(["Tax 5% of $201.00", "Tax 10% of $100.00"]))
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
    expect(text).toContain("Enhedspris ekskl. moms")
    expect(text).toContain("Beløb ekskl. moms")
    expect(text).toEqual(expect.arrayContaining(["Moms (25 %)", "1.625,00 kr.", "8.125,00 kr."]))
  })

  it("mirrors a gross basis", () => {
    const text = creditText({ ...credit, pricesIncludeTax: true, items: [{ description: "Licens", quantity: 1, unitPrice: 8125, total: 8125 }] })
    expect(text).toContain("Enhedspris inkl. moms")
    expect(text).toContain("Beløb inkl. moms")
  })

  it("prints a rounding row and labels a gross credit note's subtotal and total", () => {
    const text = creditText({
      ...credit, pricesIncludeTax: true, subtotal: 8.1, taxAmount: 2.03, total: 10.12, rounding: "-0.01",
      vatRows: [{ ratePercent: "25", net: "8.10", tax: "2.03", gross: "10.12" }],
      items: [{ description: "Vare", quantity: 1, unitPrice: 10.12, total: 10.12 }],
    })
    const subtotal = text.indexOf("Subtotal ekskl. moms")
    expect(text.slice(subtotal, subtotal + 8)).toEqual(["Subtotal ekskl. moms", "8,10 kr.", "Moms (25 %)", "2,03 kr.", "Afrunding", "-0,01 kr.", "Total inkl. moms", "10,12 kr."])
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
