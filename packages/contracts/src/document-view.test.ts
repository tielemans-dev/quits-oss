import { describe, expect, it } from "vitest"
import { documentViewSchema } from "./document-view"

const view = () => ({
  version: 1, kind: "invoice", state: "draft", status: "draft", number: { value: null, preview: "INV-0001" },
  locale: "da-DK", timezone: "Europe/Copenhagen", currency: "DKK", exponent: 2, pricesIncludeTax: false,
  seller: { name: null, email: null, phone: null, address: null, logoUrl: null, taxIds: [] }, buyer: null,
  dates: { issueDate: null, supplyDate: "2026-10-07", dueDate: null, expiryDate: null },
  lines: [{ key: "k", id: null, description: "Work", quantity: "1", unitPrice: "100", unitPriceNet: "100.00", vat: { treatment: "standard", rate: "0.25", reasonCode: null, country: null },
    net: "100.00", tax: "25.00", gross: "125.00", amount: "100.00", locked: false }],
  vatGroups: [{ key: "g", treatment: "standard", rate: "0.25", reasonCode: null, country: null, net: "100.00", tax: "25.00", gross: "125.00", payableRounding: "0.00" }],
  totals: { net: "100.00", tax: "25.00", gross: "125.00", payableRounding: "0.00", payable: "125.00" },
  vatEvidence: null, notes: null, paymentDetails: null, correction: null, calculation: { version: "v2", staleLegacy: false },
})

describe("documentViewSchema", () => {
  it("accepts a view and a view whose draft cannot be calculated", () => {
    expect(documentViewSchema.safeParse(view()).success).toBe(true)
    const uncalculated = { ...view(), vatGroups: [], totals: null, lines: [{ ...view().lines[0], net: null, tax: null, gross: null, amount: null, unitPriceNet: null }] }
    expect(documentViewSchema.safeParse(uncalculated).success).toBe(true)
  })

  it("rejects unknown keys and money that is not a plain decimal string", () => {
    expect(documentViewSchema.safeParse({ ...view(), extra: true }).success).toBe(false)
    expect(documentViewSchema.safeParse({ ...view(), totals: { ...view().totals, extra: "1" } }).success).toBe(false)
    expect(documentViewSchema.safeParse({ ...view(), totals: { ...view().totals, net: "1,5" } }).success).toBe(false)
    expect(documentViewSchema.safeParse({ ...view(), totals: { ...view().totals, net: 100 } }).success).toBe(false)
    expect(documentViewSchema.safeParse({ ...view(), exponent: 3 }).success).toBe(false)
  })
})
