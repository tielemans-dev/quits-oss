import { expect, it } from "vitest"
import { calculateDocumentInputSchema, quantityInputSchema, unitPriceInputSchema } from "./pricing"
import { vatClassificationSchema, vatEvidenceSchema, vatReasonCodes } from "./vat"
import { invoiceCreateDraftInputSchema } from "./invoices"

it("requires bounded decimal strings while preserving the existing numeric invoice contract", () => {
  expect(quantityInputSchema.parse("0.123456")).toBe("0.123456")
  expect(unitPriceInputSchema.parse("0.1234")).toBe("0.1234")
  for (const value of [0.5, "1e2", "NaN", "Infinity", "-1", ".5", "1.", " 1"])
    expect(quantityInputSchema.safeParse(value).success).toBe(false)
  expect(quantityInputSchema.safeParse("0.1234567").success).toBe(false)
  expect(unitPriceInputSchema.safeParse("0.12345").success).toBe(false)
  expect(invoiceCreateDraftInputSchema.parse({ contactId: "c", dueDate: "2026-10-07", currency: "JPY", taxRate: 0, items: [{ description: "Work", quantity: 0.5, unitPrice: 100 }] }).items[0]).toMatchObject({ quantity: 0.5, unitPrice: 100 })
})
it("validates every reason against its treatment and preserves typed evidence", () => {
  for (const [treatment, reasons] of Object.entries(vatReasonCodes)) {
    for (const reasonCode of reasons.length ? reasons : [null])
      expect(vatClassificationSchema.safeParse({ treatment, reasonCode, rate: treatment === "standard" ? "0.25" : "0" }).success).toBe(true)
  }
  expect(vatClassificationSchema.safeParse({ treatment: "export", reasonCode: "health", rate: "0" }).success).toBe(false)
  expect(vatClassificationSchema.safeParse({ treatment: "exempt", rate: "0" }).success).toBe(false)
  expect(vatEvidenceSchema.parse({ buyerVatId: "DE123", viesCheck: { at: "2026-10-07T00:00:00Z", result: "valid" }, statementText: "Reverse charge", exportEvidence: { kind: "other", ref: "carrier-1" } }).viesCheck?.result).toBe("valid")
  expect(vatEvidenceSchema.safeParse({ exportEvidence: { kind: "other", ref: "" } }).success).toBe(false)
})
it("refuses ambiguous sort orders and mixed out-of-scope documents", () => {
  const line = { quantity: "1", unitPrice: "1", sortOrder: 0, vat: { treatment: "standard", rate: "0.25" } }
  expect(calculateDocumentInputSchema.safeParse({ currency: "DKK", lines: [line, line] }).success).toBe(false)
  expect(calculateDocumentInputSchema.safeParse({ currency: "DKK", lines: [line, { ...line, sortOrder: 1, vat: { treatment: "out_of_scope", rate: "0" } }] }).success).toBe(false)
})
