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
    expect(content.fromAddress).toBe('"Acme ApS" <billing@acme.test>')
  })

  it("renders a Danish email for Danish documents", () => {
    const content = buildCreditNoteEmailContent({ ...params, org: { locale: "da-DK" } })
    expect(content.subject).toContain("Kreditnota CN-0001 til faktura INV-0001")
    expect(content.html).toContain("Hej Globex")
    expect(content.html).toContain("Årsag")
    expect(content.html).toContain('<html lang="da">')
    expect(content.html).toContain("<title>Kreditnota CN-0001</title>")
  })
  it.each(["da-DK", "en-US"])("uses frozen legal parties and the frozen line rate in %s", locale => {
    const content = buildCreditNoteEmailContent({ ...params, org: { locale, companyName: "Current seller", companyAddress: "Current address" }, creditNote: { ...params.creditNote,
      sellerSnapshot: { companyName: "Frozen <seller>", companyAddress: "Seller road 1", momsRegistered: null, taxIds: [{ scheme: "cvr", value: "12345678" }] },
      buyerSnapshot: { name: "Frozen <buyer>", address: "Buyer road 2", city: "Berlin", zip: "10000", country: "DE", taxIds: [{ scheme: "vat", value: "DE999999999" }] },
      taxRate: 25, items: [5, 25].map(taxRate => ({ description: `Service ${taxRate}`, quantity: 1, unitPrice: 100, total: 100, taxRate })),
    } })
    for (const value of ["Frozen &lt;seller&gt;", "Seller road 1", "12345678", "Frozen &lt;buyer&gt;", "Buyer road 2", "DE999999999"]) expect(content.html).toContain(value)
    expect(content.html).not.toContain("Current address")
    expect(content.html).not.toMatch(/(?:VAT no\.|Momsnr\.) DK12345678/)
    const reduced = content.html.split("<tr>").find(row => row.includes("Service 5"))!
    expect(reduced).toContain(locale === "da-DK" ? "5 % moms" : "5% tax")
  })

  it.each([
    ["da-DK", "Kreditnota CN-0001 af 6. oktober 2026 til faktura INV-0001.", "Kreditnotaen er vedhæftet som PDF."],
    ["en-US", "Credit note CN-0001 dated October 6, 2026 for invoice INV-0001.", "The credit note is attached as a PDF."],
  ])("shows the credit note's own number and issue date in %s, and the PDF only when attached", (locale, issued, attached) => {
    const without = buildCreditNoteEmailContent({ ...params, org: { locale, timezone: "UTC" } })
    expect(without.html).toContain(issued)
    expect(without.html).not.toContain(attached)
    expect(buildCreditNoteEmailContent({ ...params, org: { locale, timezone: "UTC" }, pdfAttached: true }).html).toContain(`${issued} ${attached}`)
  })

})
