import { isValidElement, type ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { Text, View } from "@react-pdf/renderer"
import { InvoicePdfDocument, type InvoiceForPdf } from "../invoice-pdf"

const invoice: InvoiceForPdf = {
  number: "INV-0002", status: "sent", issueDate: "2026-10-11T12:00:00Z", dueDate: "2026-10-25",
  subtotal: 1000, taxAmount: 250, total: 1250, currency: "DKK", notes: null,
  contact: { name: "Test buyer", company: "Test company", email: "buyer@example.test", address: "Testvej 2", zip: "9000", city: "Aalborg", country: "DK" },
  items: [{ description: "Test service", quantity: 1, unitPrice: 1000, total: 1000 }],
}

function elements(node: ReactNode): React.ReactElement<{ children?: ReactNode; style?: unknown; fixed?: boolean }>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<{ children?: ReactNode; style?: unknown; fixed?: boolean }>(node)) return []
  return [node, ...elements(node.props.children)]
}

function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children)
  return typeof node === "string" || typeof node === "number" ? String(node) : ""
}

describe("invoice PDF layout", () => {
  it.each(["da-DK", "en-US"])("prints seller identity, postal address and document dates in %s", locale => {
    const nodes = elements(InvoicePdfDocument({ invoice, org: { companyName: "Test Seller ApS", locale, timezone: "Europe/Copenhagen" } }))
    const lines = nodes.filter(node => node.type === Text).map(node => text(node))
    expect(lines[0]).toBe("Test Seller ApS")
    expect(lines).toContain("9000 Aalborg")
    expect(lines).toContain(locale === "da-DK" ? "Danmark" : "Denmark")
    expect(lines).toContain(locale === "da-DK" ? "11. okt. 2026" : "Oct 11, 2026")
    expect(lines).not.toContain("buyer@example.test")
    expect(lines).not.toContain("DK")
    expect(lines).not.toContain(locale === "da-DK" ? "Sendt" : "Sent")
    expect(lines).not.toContain("quits.")
    const footer = nodes.find(node => node.type === View && node.props.fixed)
    expect(footer).toBeDefined()
    expect(text(footer)).toContain("Test Seller ApS")
    const parties = nodes.find(node => node.type === View &&
      Array.isArray(node.props.children) && node.props.children.length === 2 &&
      text(node.props.children[0]).includes(locale === "da-DK" ? "Fra" : "From") &&
      text(node.props.children[1]).includes(locale === "da-DK" ? "Fakturer til" : "Bill To"))
    expect(parties?.props.style).toMatchObject({ flexDirection: "row" })
  })

  it.each(["draft", "paid", "overdue", "credited"])("keeps app status %s out of the PDF", status => {
    const lines = elements(InvoicePdfDocument({ invoice: { ...invoice, status } })).filter(node => node.type === Text).map(node => text(node))
    expect(lines).not.toContain(status)
    expect(lines).not.toContain({ draft: "Draft", paid: "Paid", overdue: "Overdue", credited: "Credited" }[status])
  })
})
