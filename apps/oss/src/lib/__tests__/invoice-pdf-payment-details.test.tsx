import { isValidElement, type ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { Text, renderToBuffer } from "@react-pdf/renderer"
import { parseSellerSnapshot } from "@quits/contracts/documents"
import { InvoicePdfDocument, type InvoiceForPdf } from "../invoice-pdf"
import { buildPaymentDetailsBlock } from "../payment-details-block"

const bankDetails = {
  accountHolder: "Nordic Design ApS",
  bankName: "Danske Bank",
  regNumber: "0040",
  accountNumber: "0440116243",
  iban: "DK5000400440116243",
  bic: "DABADKKK",
  note: "MobilePay Box 12345",
}

const invoice: InvoiceForPdf = {
  number: "INV-0042",
  status: "sent",
  issueDate: "2026-10-01T00:00:00.000Z",
  dueDate: "2026-10-31T00:00:00.000Z",
  subtotal: 1000,
  taxAmount: 250,
  total: 1250,
  currency: "DKK",
  notes: null,
  contact: { name: "Kunde A/S" },
  items: [{ description: "Design", quantity: 1, unitPrice: 1250, total: 1250 }],
}

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

const renderedText = (input: InvoiceForPdf, locale: string) =>
  textOf(InvoicePdfDocument({ invoice: input, org: { locale } })).join("\n")

describe("payment details block", () => {
  it("lists every given detail with the invoice number as payment reference", () => {
    expect(buildPaymentDetailsBlock(bankDetails, "INV-0042", "en-US")).toEqual({
      title: "Payment details",
      rows: [
        { label: "Reg. no.", value: "0040" },
        { label: "Account no.", value: "0440116243" },
        { label: "IBAN", value: "DK50 0040 0440 1162 43" },
        { label: "BIC", value: "DABADKKK" },
        { label: "Account holder", value: "Nordic Design ApS" },
        { label: "Bank", value: "Danske Bank" },
      ],
      note: "MobilePay Box 12345",
      reference: { label: "Payment reference", value: "INV-0042" },
    })
  })

  it("is written in Danish for a Danish organization", () => {
    expect(buildPaymentDetailsBlock(bankDetails, "INV-0042", "da-DK")).toMatchObject({
      title: "Betalingsoplysninger",
      rows: [
        { label: "Reg.nr.", value: "0040" },
        { label: "Kontonr.", value: "0440116243" },
        { label: "IBAN", value: "DK50 0040 0440 1162 43" },
        { label: "BIC", value: "DABADKKK" },
        { label: "Kontohaver", value: "Nordic Design ApS" },
        { label: "Bank", value: "Danske Bank" },
      ],
      reference: { label: "Betalingsreference", value: "INV-0042" },
    })
  })

  it("only lists what is present", () => {
    const block = buildPaymentDetailsBlock({ iban: "DK5000400440116243", regNumber: null, note: "  " }, "INV-1", "en")
    expect(block?.rows).toEqual([{ label: "IBAN", value: "DK50 0040 0440 1162 43" }])
    expect(block?.note).toBeNull()

    const noteOnly = buildPaymentDetailsBlock({ note: "MobilePay Box 12345" }, "INV-1", "en")
    expect(noteOnly?.rows).toEqual([])
    expect(noteOnly?.note).toBe("MobilePay Box 12345")
  })

  it("is absent without any detail, also for documents issued before the feature", () => {
    expect(buildPaymentDetailsBlock(undefined, "INV-1", "en")).toBeNull()
    expect(buildPaymentDetailsBlock(null, "INV-1", "en")).toBeNull()
    expect(buildPaymentDetailsBlock({}, "INV-1", "en")).toBeNull()
    expect(buildPaymentDetailsBlock({ iban: " ", note: "" }, "INV-1", "en")).toBeNull()
  })
})

describe("invoice PDF payment details", () => {
  it("shows the block after the totals and before the notes", () => {
    const text = renderedText({ ...invoice, notes: "Thank you", bankDetails }, "en-US")
    const order = ["Subtotal", "Payment details", "Payment reference: INV-0042", "Notes", "Thank you"].map((needle) =>
      text.lastIndexOf(needle)
    )
    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(text).toContain("DK50 0040 0440 1162 43")
    expect(text).toContain("MobilePay Box 12345")
  })

  it("prints the payment reference as one line", () => {
    expect(renderedText({ ...invoice, bankDetails }, "en-US").split("\n")).toContain("Payment reference: INV-0042")
    expect(renderedText({ ...invoice, bankDetails }, "da-DK").split("\n")).toContain("Betalingsreference: INV-0042")
  })

  it("is localized", () => {
    const text = renderedText({ ...invoice, bankDetails }, "da-DK")
    expect(text).toContain("Betalingsoplysninger")
    expect(text).toContain("Reg.nr.")
    expect(text).toContain("Kontonr.")
    expect(text).toContain("Betalingsreference")
    expect(text).not.toContain("Payment details")
  })

  it("leaves out the block without bank details, as on documents issued earlier", () => {
    for (const bankDetailsValue of [undefined, null, {}] as const) {
      const text = renderedText({ ...invoice, bankDetails: bankDetailsValue }, "en-US")
      expect(text).not.toContain("Payment details")
      expect(text).not.toContain("Payment reference")
    }
  })

  it("renders an invoice whose seller snapshot predates bank details", async () => {
    const legacy = parseSellerSnapshot({ companyName: "Old ApS", taxIds: [] })
    const buffer = await renderToBuffer(
      InvoicePdfDocument({ invoice: { ...invoice, bankDetails: legacy?.bankDetails }, org: { locale: "da-DK" } }) as never
    )
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-")
  })

  it("renders a complete PDF with bank details in both languages", async () => {
    for (const locale of ["en-US", "da-DK"]) {
      const buffer = await renderToBuffer(
        InvoicePdfDocument({ invoice: { ...invoice, bankDetails }, org: { locale } }) as never
      )
      expect(buffer.subarray(0, 5).toString()).toBe("%PDF-")
      expect(buffer.byteLength).toBeGreaterThan(1000)
    }
  })
})
