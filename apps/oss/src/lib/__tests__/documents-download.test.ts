import { describe, expect, it } from "vitest"
import { documentPdfFileName } from "../documents-download"

describe("downloaded PDF names", () => {
  it("names an issued document by its number", () => {
    expect(documentPdfFileName("invoice", "2026-0001", { customer: "Havbrise Logistik A/S", locale: "da-DK" })).toBe("2026-0001.pdf")
    expect(documentPdfFileName("creditNote", " CN-0002 ")).toBe("CN-0002.pdf")
  })

  it.each([
    ["invoice", "da-DK", "kladde-faktura-havbrise-logistik-a-s.pdf"],
    ["quote", "da-DK", "kladde-tilbud-havbrise-logistik-a-s.pdf"],
    ["invoice", "en-US", "draft-invoice-havbrise-logistik-a-s.pdf"],
  ] as const)("names a %s draft in %s for what it is and whom it is for", (kind, locale, name) => {
    expect(documentPdfFileName(kind, null, { customer: "Havbrise Logistik A/S", locale })).toBe(name)
  })

  it("keeps Danish letters and names a draft without a customer by kind alone", () => {
    expect(documentPdfFileName("invoice", null, { customer: "Ærø Søfart & Co.", locale: "da-DK" })).toBe("kladde-faktura-ærø-søfart-co.pdf")
    expect(documentPdfFileName("invoice", "", { customer: " ", locale: "da-DK" })).toBe("kladde-faktura.pdf")
    expect(documentPdfFileName("quote", null)).toBe("draft-quote.pdf")
  })
})
