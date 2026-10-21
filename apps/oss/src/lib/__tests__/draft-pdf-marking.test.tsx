import { isValidElement, type ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { Text } from "@react-pdf/renderer"
import { InvoicePdfDocument, type InvoiceForPdf } from "../invoice-pdf"

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
const draft = { ...invoice, number: "", status: "draft" }
const quote = { expiryDate: "2026-10-31T00:00:00.000Z" }

/** The text of a react-pdf element tree, one entry per `Text` element, in document order. */
function textOf(node: ReactNode): string[] {
  if (Array.isArray(node)) return node.flatMap(textOf)
  if (isValidElement<{ children?: ReactNode }>(node)) {
    const inner = textOf(node.props.children)
    return node.type === Text ? [inner.join("")] : inner
  }
  return typeof node === "string" || typeof node === "number" ? [String(node)] : []
}
const textFor = (input: InvoiceForPdf, locale: string, asQuote = false) =>
  textOf(InvoicePdfDocument({ invoice: input, org: { locale }, quote: asQuote ? quote : undefined }))

describe("draft PDF marking", () => {
  it.each([
    ["da-DK", false, ["KLADDE", "Kladde – ikke en gyldig faktura", "Fakturakladde "]],
    ["en-US", false, ["DRAFT", "Draft – not a valid invoice", "Draft invoice "]],
    ["da-DK", true, ["KLADDE", "Kladde – ikke et gyldigt tilbud", "Tilbudskladde "]],
    ["en-US", true, ["DRAFT", "Draft – not a valid quote", "Draft quote "]],
  ] as const)("marks a %s draft (quote: %s) as not valid", (locale, asQuote, marking) => {
    expect(textFor(draft, locale, asQuote)).toEqual(expect.arrayContaining([...marking]))
  })

  it.each([["da-DK", false], ["en-US", false], ["da-DK", true], ["en-US", true]] as const)(
    "leaves an issued %s document (quote: %s) unmarked",
    (locale, asQuote) => {
      const text = textFor(invoice, locale, asQuote).join("\n")
      expect(text).not.toMatch(/kladde|draft|ikke en gyldig|ikke et gyldigt|not a valid/i)
    },
  )

  it("repeats the marking on every page", () => {
    const fixed = (node: ReactNode): string[] => {
      if (Array.isArray(node)) return node.flatMap(fixed)
      if (!isValidElement<{ children?: ReactNode; fixed?: boolean }>(node)) return []
      return node.props.fixed ? textOf(node) : fixed(node.props.children)
    }
    expect(fixed(InvoicePdfDocument({ invoice: draft, org: { locale: "da-DK" } })))
      .toEqual(expect.arrayContaining(["KLADDE", "Kladde – ikke en gyldig faktura"]))
  })
})
