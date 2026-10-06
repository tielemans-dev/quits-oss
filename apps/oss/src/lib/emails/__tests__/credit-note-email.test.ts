import { describe, expect, it } from "vitest"
import { buildCreditNoteEmailContent } from "../credit-note-email"

const params = {
  fromName: "Acme ApS",
  fromEmail: "billing@acme.test",
  creditNote: {
    number: "CN-0001",
    issueDate: "2026-10-06T00:00:00Z",
    reason: "Damaged <goods>",
    subtotal: 80,
    taxAmount: 20,
    total: 100,
    currency: "DKK",
    items: [{ description: "Credit for INV-0001", quantity: 1, unitPrice: 100, total: 100 }],
  },
  invoice: { number: "INV-0001", issueDate: "2026-09-01T00:00:00Z" },
  contactName: "Globex",
}

describe("credit note email", () => {
  it("renders an English email that references the invoice", () => {
    const content = buildCreditNoteEmailContent({ ...params, org: { locale: "en-US" } })
    expect(content.subject).toContain("Credit note CN-0001 for invoice INV-0001")
    expect(content.html).toContain("Credits invoice")
    expect(content.html).toContain("Damaged &lt;goods&gt;")
    expect(content.fromAddress).toBe("Acme ApS <billing@acme.test>")
  })

  it("renders a Danish email for Danish documents", () => {
    const content = buildCreditNoteEmailContent({ ...params, org: { locale: "da-DK" } })
    expect(content.subject).toContain("Kreditnota CN-0001 til faktura INV-0001")
    expect(content.html).toContain("Hej Globex")
    expect(content.html).toContain("Årsag")
  })
})
