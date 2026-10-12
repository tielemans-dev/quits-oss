import { isValidElement, type ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { Text, renderToBuffer } from "@react-pdf/renderer"
import { parseSellerSnapshot } from "@quits/contracts/documents"
import { InvoicePdfDocument, type InvoiceForPdf } from "../invoice-pdf"
import { withInvoicePaymentDetails } from "../../domain/documents/snapshots"
import { buildPaymentDetailsBlock } from "../payment-details-block"

const bankAccount = {
  accountHolder: "Nordic Design ApS",
  bankName: "Danske Bank",
  regNumber: "0040",
  accountNumber: "0440116243",
  iban: "DK5000400440116243",
  bic: "DABADKKK",
}
const paymentNote = "MobilePay Box 12345"
const details = { bankAccount, note: paymentNote }
/** The payment details of an invoice, as the PDF input carries them. */
const payment = { bankAccount, paymentNote }

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
    expect(buildPaymentDetailsBlock(details, "INV-0042", "en-US")).toEqual({
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
      reference: { label: "Payment message", value: "INV-0042" },
    })
  })

  it("is written in Danish for a Danish organization", () => {
    expect(buildPaymentDetailsBlock(details, "INV-0042", "da-DK")).toMatchObject({
      title: "Betalingsoplysninger",
      rows: [
        { label: "Reg.nr.", value: "0040" },
        { label: "Kontonr.", value: "0440116243" },
        { label: "IBAN", value: "DK50 0040 0440 1162 43" },
        { label: "BIC", value: "DABADKKK" },
        { label: "Kontohaver", value: "Nordic Design ApS" },
        { label: "Bank", value: "Danske Bank" },
      ],
      reference: { label: "Betalingsbesked", value: "INV-0042" },
    })
  })

  it("only lists what is present", () => {
    const block = buildPaymentDetailsBlock({ bankAccount: { iban: "DK5000400440116243", regNumber: null }, note: "  " }, "INV-1", "en")
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
    expect(buildPaymentDetailsBlock({ bankAccount: { iban: " " }, note: "" }, "INV-1", "en")).toBeNull()
    expect(buildPaymentDetailsBlock({ bankAccount: null, note: null }, "INV-1", "en")).toBeNull()
  })
})

describe("payment details block reference", () => {
  it("has no reference row for a null or blank reference", () => {
    expect(buildPaymentDetailsBlock(details, null, "en")?.reference).toBeNull()
    expect(buildPaymentDetailsBlock(details, "  ", "en")?.reference).toBeNull()
    expect(buildPaymentDetailsBlock(details, " KID 123 ", "en")?.reference).toEqual({ label: "Payment message", value: "KID 123" })
  })
})

describe("invoice PDF payment details", () => {
  it("shows the block after the totals and before the notes", () => {
    const text = renderedText({ ...invoice, notes: "Thank you", ...payment }, "en-US")
    const order = ["Subtotal", "Payment details", "Payment message: INV-0042", "Notes", "Thank you"].map((needle) =>
      text.lastIndexOf(needle)
    )
    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(text).toContain("DK50 0040 0440 1162 43")
    expect(text).toContain("MobilePay Box 12345")
  })

  it("prints the payment reference as one line", () => {
    expect(renderedText({ ...invoice, ...payment }, "en-US").split("\n")).toContain("Payment message: INV-0042")
    expect(renderedText({ ...invoice, ...payment }, "da-DK").split("\n")).toContain("Betalingsbesked: INV-0042")
  })

  it("prints the invoice's own payment reference instead of the number", () => {
    const text = renderedText({ ...invoice, ...payment, paymentReference: "+71 1234 5678" }, "en-US")
    expect(text.split("\n")).toContain("Payment message: +71 1234 5678")
    expect(text).not.toContain("Payment message: INV-0042")
  })

  it("leaves the reference row out of a draft, which has no reference yet", () => {
    const text = renderedText({ ...invoice, number: "draft", status: "draft", ...payment, paymentReference: null }, "en-US")
    expect(text).toContain("Payment details")
    expect(text).not.toContain("Payment message")
    expect(text).not.toContain(": draft")
  })

  it("is localized", () => {
    const text = renderedText({ ...invoice, ...payment }, "da-DK")
    expect(text).toContain("Betalingsoplysninger")
    expect(text).toContain("Reg.nr.")
    expect(text).toContain("Kontonr.")
    expect(text).toContain("Betalingsbesked")
    expect(text).not.toContain("Payment details")
  })

  it("leaves out the block without payment details, as on documents issued earlier", () => {
    for (const empty of [{}, { bankAccount: null, paymentNote: null }, { bankAccount: {} }] as const) {
      const text = renderedText({ ...invoice, ...empty }, "en-US")
      expect(text).not.toContain("Payment details")
      expect(text).not.toContain("Payment message")
    }
  })

  it("renders an invoice whose seller snapshot predates payment details", async () => {
    const legacy = parseSellerSnapshot({ companyName: "Old ApS", taxIds: [] })
    const buffer = await renderToBuffer(
      InvoicePdfDocument({ invoice: { ...invoice, bankAccount: legacy?.bankAccount, paymentNote: legacy?.paymentNote }, org: { locale: "da-DK" } }) as never
    )
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-")
  })

  it("renders a complete PDF with payment details in both languages", async () => {
    for (const locale of ["en-US", "da-DK"]) {
      const buffer = await renderToBuffer(
        InvoicePdfDocument({ invoice: { ...invoice, ...payment }, org: { locale } }) as never
      )
      expect(buffer.subarray(0, 5).toString()).toBe("%PDF-")
      expect(buffer.byteLength).toBeGreaterThan(1000)
    }
  })
})


describe("invoice PDF calendar dates", () => {
  it.each(["America/New_York", "Pacific/Pago_Pago", "Europe/Copenhagen"])(
    "preserves due and supply days while localizing the issue instant in %s", timezone => {
      const text = textOf(InvoicePdfDocument({
        invoice: { ...invoice, dueDate: "2028-02-29T00:00:00.000Z", supplyDate: "2027-03-14" },
        org: { locale: "en-US", timezone },
      })).join("\n")
      expect(text).toContain("February 29, 2028")
      expect(text).toContain("March 14, 2027")
      expect(text).toContain(timezone === "Europe/Copenhagen" ? "October 1, 2026" : "September 30, 2026")
    }
  )
})


describe("registration changes in future PDF snapshots", () => {
  it.each(["da-DK", "en-US"])("keeps old PDFs frozen and normalizes future declarations in %s", locale => {
    const statement = locale === "da-DK" ? "Der er ikke beregnet moms, da sælger ikke er momsregistreret." : "No VAT charged – the seller is not VAT-registered."
    const seller = { companyName: "Synthetic seller", companyEmail: null, companyAddress: null, taxIds: [], momsRegistered: false }
    const old = withInvoicePaymentDetails(seller, { paymentNote: "Custom payment instruction" }, locale)
    const oldPdf = renderedText({ ...invoice, ...old }, locale)
    expect(oldPdf).toContain(statement)
    expect(oldPdf).toContain("Custom payment instruction")
    const registered = withInvoicePaymentDetails({ ...seller, momsRegistered: true }, { paymentNote: parseSellerSnapshot(old)?.paymentNote }, locale)
    const registeredPdf = renderedText({ ...invoice, ...registered }, locale)
    expect(registeredPdf).not.toContain(statement)
    expect(registeredPdf).toContain("Custom payment instruction")
    const unregistered = withInvoicePaymentDetails(seller, { paymentNote: parseSellerSnapshot(registered)?.paymentNote }, locale)
    expect(renderedText({ ...invoice, ...unregistered }, locale)).toContain(statement)
    expect(renderedText({ ...invoice, ...old }, locale)).toBe(oldPdf)
  })
})


describe("historical generated payment declarations", () => {
  it.each(["Virksomheden er ikke momsregistreret.", "The company is not VAT registered."])("removes %s only from future registered snapshots", oldNote => {
    const seller = { companyName: "Synthetic seller", companyEmail: null, companyAddress: null, taxIds: [], momsRegistered: true }
    const future = withInvoicePaymentDetails(seller, { paymentNote: `${oldNote}\nCustom instruction` }, "en-US")
    expect(parseSellerSnapshot(future)?.paymentNote).toBe("Custom instruction")
  })
})
