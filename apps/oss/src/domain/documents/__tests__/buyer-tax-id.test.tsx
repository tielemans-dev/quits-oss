// MOCK: synthetic test parties, numbers and amounts only.
import { isValidElement, type ReactNode } from "react"
import { Text } from "@react-pdf/renderer"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { buildBuyerSnapshot } from "../snapshots"
import { requireVatIssuance } from "../vat-issuance"
import { InvoicePdfDocument, type InvoiceForPdf } from "../../../lib/invoice-pdf"
import { CreditNotePdfDocument, type CreditNoteForPdf } from "../../../lib/credit-note-pdf"
import { buildBuyerParty } from "../../../lib/exports/einvoice"

function pdfText(node: ReactNode): string[] {
  if (node == null || typeof node === "boolean") return []
  if (typeof node === "string" || typeof node === "number") return [String(node)]
  if (Array.isArray(node)) return node.flatMap(pdfText)
  if (isValidElement<{ children?: ReactNode }>(node)) { const children = pdfText(node.props.children); return node.type === Text ? [children.join("")] : children }
  return []
}

// A contact made from a CVR lookup: the number sits only in the single tax ID field.
const danish = { name: "Synthetic Buyer", email: null, company: "Synthetic Buyer ApS", address: "Testvej 2", city: "København", state: null, zip: "1000", country: "DK", taxId: "12345674", taxIds: [] }
const german = { ...danish, company: "Synthetic Käufer GmbH", address: "Teststraße 5", city: "Berlin", zip: "10115", country: "DE", taxId: "DE123456789" }

function invoicePdf(contact: typeof danish, locale: string) {
  const invoice: InvoiceForPdf = { number: "SYNTHETIC-0001", status: "sent", issueDate: "2026-10-09T12:00:00Z", dueDate: "2026-11-09", subtotal: 100, taxAmount: 25, total: 125, currency: "DKK", notes: null, pricesIncludeTax: false,
    contact: buildBuyerSnapshot(contact), items: [{ description: "Synthetic consulting", quantity: 1, unitPrice: 100, total: 100 }] }
  return pdfText(InvoicePdfDocument({ invoice, org: { companyName: "Synthetic Seller ApS", locale } })).join(" ")
}
function creditNotePdf(contact: typeof danish, locale: string) {
  const creditNote: CreditNoteForPdf = { number: "SYNTHETIC-CN-0001", issueDate: "2026-10-10T12:00:00Z", reason: "Synthetic correction", subtotal: 100, taxAmount: 25, total: 125, currency: "DKK", locale,
    invoice: { number: "SYNTHETIC-0001", issueDate: "2026-10-09T12:00:00Z" }, buyerSnapshot: buildBuyerSnapshot(contact), contact, items: [{ description: "Synthetic consulting", quantity: 1, unitPrice: 100, total: 100 }] }
  return pdfText(CreditNotePdfDocument({ creditNote, org: { companyName: "Synthetic Seller ApS" } })).join(" ")
}

describe("buyer tax ID from the contact's single field", () => {
  it("keeps a Danish number as the buyer's CVR and other numbers as VAT numbers", () => {
    expect(buildBuyerSnapshot(danish).taxIds).toEqual([{ scheme: "cvr", value: "12345674", countryCode: "DK" }])
    expect(buildBuyerSnapshot({ ...danish, taxId: "DK 12345674", country: "Denmark" }).taxIds).toEqual([{ scheme: "cvr", value: "12345674", countryCode: "DK" }])
    expect(buildBuyerSnapshot(german).taxIds).toEqual([{ scheme: "VAT", value: "DE123456789", countryCode: "DE" }])
    expect(buildBuyerSnapshot({ ...danish, taxIds: undefined }).taxIds).toHaveLength(1)
    expect(buildBuyerSnapshot({ ...danish, taxId: " " }).taxIds).toEqual([])
  })
  it("prefers the contact's tax ID list when it has entries", () => {
    expect(buildBuyerSnapshot({ ...danish, taxIds: [{ scheme: "se", value: "87654321", countryCode: "DK" }] }).taxIds).toEqual([{ scheme: "se", value: "87654321", countryCode: "DK" }])
  })
  it.each([["da-DK", "CVR-nr. 12345674"], ["en-US", "CVR no. 12345674"]])("prints the CVR on the invoice and credit-note PDFs in %s", (locale, line) => {
    expect(invoicePdf(danish, locale)).toContain(line)
    expect(creditNotePdf(danish, locale)).toContain(line)
  })
  it("prints an EU buyer's number as a VAT number on both PDFs", () => {
    expect(invoicePdf(german, "da-DK")).toContain("Momsnr. DE123456789")
    expect(creditNotePdf(german, "da-DK")).toContain("Momsnr. DE123456789")
  })
  it("gives the e-invoice the same buyer identifiers", () => {
    const party = (contact: typeof danish) => buildBuyerParty(buildBuyerSnapshot(contact), { ...contact, taxIds: [], peppolEndpointId: null, peppolEndpointScheme: null } as never)
    expect(party(danish)).toMatchObject({ vatId: "DK12345674", legalId: { id: "12345674", scheme: "0184" } })
    expect(party(german)).toMatchObject({ vatId: "DE123456789" })
  })
})

describe("EU B2B issuance for a contact with only a single tax ID", () => {
  const evidence = { buyerVatId: "DE123456789", viesCheck: { at: "2026-10-09T12:00:00Z", result: "valid" as const }, statementText: "Reverse charge" }
  const document = (buyerSnapshot: unknown, vatEvidence: unknown = evidence) => ({
    taxRegime: "eu_vat", currency: "EUR", pricesIncludeTax: false, subtotalNet: "100", totalTax: "0", totalGross: "100", vatEvidence,
    sellerSnapshot: { countryCode: "DK", momsRegistered: true, taxIds: [{ scheme: "cvr", value: "24256790", countryCode: "DK" }, { scheme: "vat", value: "DK24256790", countryCode: "DK" }] },
    buyerSnapshot,
    items: [{ vatRateInput: "0", vatTreatment: "intra_community", vatReasonCode: "services_b2b", vatCountry: "DE", taxRate: "0", lineNet: "100", lineTax: "0", lineGross: "100" }],
  })
  it("accepts VIES evidence that matches the buyer's number", async () => {
    expect(await Effect.runPromise(Effect.either(requireVatIssuance(document(buildBuyerSnapshot(german)))))).toMatchObject({ _tag: "Right" })
    // A number stored without its country prefix is the same VAT number.
    expect(await Effect.runPromise(Effect.either(requireVatIssuance(document(buildBuyerSnapshot({ ...german, taxId: "123 456 789" })))))).toMatchObject({ _tag: "Right" })
  })
  it("still refuses evidence for a different number", async () => {
    expect(await Effect.runPromise(Effect.either(requireVatIssuance(document(buildBuyerSnapshot(german), { ...evidence, buyerVatId: "DE999999999" }))))).toMatchObject({ _tag: "Left", left: { code: "evidence_incomplete" } })
  })
})
