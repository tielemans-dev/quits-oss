import { isValidElement, type ReactNode } from "react"
import { Text } from "@react-pdf/renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "../../../generated/prisma/client"
import { QuotePdfDocument, renderQuotePdf } from "../quote-pdf"
import { InvoicePdfDocument } from "../invoice-pdf"
import { resetRuntimeServices, setRuntimeServices } from "../runtime/services"

afterEach(resetRuntimeServices)

function textOf(node: ReactNode): string[] {
  if (Array.isArray(node)) return node.flatMap(textOf)
  if (isValidElement<{ children?: ReactNode }>(node)) {
    const inner = textOf(node.props.children)
    return node.type === Text ? [inner.join("").replace(/[  ]/g, " ")] : inner
  }
  return typeof node === "string" || typeof node === "number" ? [String(node)] : []
}
const decimal = (value: number) => new Prisma.Decimal(value)
function fixture() {
  return {
    id: "quote-21", organizationId: "org-21",
    number: "T-0021", status: "sent", issueDate: new Date("2026-10-15T10:00:00Z"),
    expiryDate: new Date("2026-10-31T00:00:00Z"), locale: "da-DK", timezone: "Pacific/Honolulu",
    subtotalNet: decimal(100), totalTax: decimal(25), totalGross: decimal(125),
    currency: "DKK", pricesIncludeTax: false, taxRegime: "eu_vat", notes: "Aftales med kunden.",
    sellerSnapshot: { companyName: "Saved seller", companyEmail: "saved@example.test", momsRegistered: true },
    buyerSnapshot: { name: "Saved buyer", address: "Kundevej 1", city: "Aalborg", zip: "9000", country: "DK" },
    contact: { name: "Changed buyer" }, organization: { settings: { companyName: "Changed seller", locale: "en-US" } },
    items: [2, 1].map(sortOrder => ({ description: `Line ${sortOrder}`, sortOrder, quantity: decimal(3),
      unitPriceNet: decimal(16.67), unitPriceGross: decimal(20.83), lineNet: decimal(50), lineTax: decimal(12.5),
      lineGross: decimal(62.5), taxRate: decimal(25), vatTreatment: "standard", vatReasonCode: null, vatCountry: "DK" })),
  } as unknown as Parameters<typeof QuotePdfDocument>[0]["quote"]
}

describe("quote PDFs", () => {
  it("marks the document Tilbud, keeps identities, dates and notes, and omits invoice wording", () => {
    const text = textOf(QuotePdfDocument({ quote: fixture() }))
    expect(text).toEqual(expect.arrayContaining(["Tilbud T-0021", "Tilbudsdato", "Gyldigt til", "31. oktober 2026",
      "Saved seller", "Saved buyer", "9000 Aalborg", "Aftales med kunden.", "Moms 25 %", "25,00 kr.", "125,00 kr."]))
    expect(text.join(" ")).not.toMatch(/Faktura|Fakturer til|Forfaldsdato|Betalings|Changed/)
    expect(text.indexOf("Line 1")).toBeLessThan(text.indexOf("Line 2"))
  })
  it.each([false, true])("uses stored line amounts for pricesIncludeTax=%s", pricesIncludeTax => {
    const text = textOf(QuotePdfDocument({ quote: { ...fixture(), pricesIncludeTax } }))
    expect(text).toContain(pricesIncludeTax ? "Enhedspris inkl. moms" : "Enhedspris ekskl. moms")
    expect(text).toContain(pricesIncludeTax ? "20,83 kr." : "16,67 kr.")
    expect(text).toContain(pricesIncludeTax ? "62,50 kr." : "50,00 kr.")
    expect(text).not.toContain(pricesIncludeTax ? "62,49 kr." : "50,01 kr.")
    expect(text).toContain("125,00 kr.")
  })
  it("labels an unnumbered draft and follows the quote's English locale", () => {
    const text = textOf(QuotePdfDocument({ quote: { ...fixture(), number: null, status: "draft", locale: "en-US" } }))
    expect(text).toEqual(expect.arrayContaining(["Draft quote ", "Quote date", "Valid until", "October 31, 2026"]))
    expect(text.join(" ")).not.toMatch(/Invoice|Due Date|null|T-0021/)
  })
  it("delegates serializable quote presentation to the configured host renderer", async () => {
    const bytes = new TextEncoder().encode("%PDF-host")
    const renderPdf = vi.fn().mockResolvedValue(bytes)
    setRuntimeServices({ documentRenderer: { version: "worker-test", renderPdf } })
    expect(await renderQuotePdf(fixture())).toBe(bytes)
    const input = renderPdf.mock.calls[0][0]
    expect(input).toMatchObject({ kind: "quote", organizationId: "org-21", documentId: "quote-21",
      number: "T-0021", issuedAt: "2026-10-15T10:00:00.000Z",
      pdf: { invoice: { total: 125, contact: { name: "Saved buyer" } },
        quote: { expiryDate: "2026-10-31T00:00:00.000Z" }, org: { companyName: "Saved seller" } } })
    expect(JSON.parse(JSON.stringify(input))).toEqual(input)
    expect(textOf(QuotePdfDocument({ quote: fixture() }))).toEqual(textOf(InvoicePdfDocument(input.pdf)))
  })
  it("requires a configured host renderer", async () => {
    resetRuntimeServices()
    await expect(renderQuotePdf(fixture())).rejects.toThrow("Document renderer unavailable")
  })
})
