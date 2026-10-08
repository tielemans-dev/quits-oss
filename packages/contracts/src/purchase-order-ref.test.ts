import { describe, expect, it } from "vitest"
import {
  invoiceCreateDraftInputSchema, invoiceCreateDraftV2InputSchema, invoiceUpdateDraftInputSchema,
  invoiceUpdateDraftV2InputSchema, invoiceCreateFromDeliverablesInputSchema, purchaseOrderRefInputSchema,
} from "./invoices"

const cases = [
  [invoiceCreateDraftInputSchema, { contactId: "c", dueDate: "2026-12-01", items: [{ description: "Work", quantity: 1, unitPrice: 100 }] }],
  [invoiceCreateDraftV2InputSchema, { contactId: "c", dueDate: "2026-12-01", supplyDate: "2026-10-08", items: [{ description: "Work", quantity: "1", unitPrice: "100" }] }],
  [invoiceUpdateDraftInputSchema, { id: "i" }],
  [invoiceUpdateDraftV2InputSchema, { id: "i", expectedRevision: 2 }],
  [invoiceCreateFromDeliverablesInputSchema, { agreementId: "a", deliverableIds: ["d"] }],
] as const

describe("purchaseOrderRef input", () => {
  it("normalizes consistently across invoice inputs without replacing omitted values", () => {
    for (const [schema, input] of cases) {
      expect(schema.parse(input).purchaseOrderRef).toBeUndefined()
      for (const purchaseOrderRef of [null, "", " \t\r\n "]) {
        expect(schema.parse({ ...input, purchaseOrderRef }).purchaseOrderRef).toBeNull()
      }
      expect(schema.parse({ ...input, purchaseOrderRef: "  Ordre Æ-42 / A&B  " }).purchaseOrderRef).toBe("Ordre Æ-42 / A&B")
      expect(schema.safeParse({ ...input, purchaseOrderRef: 123 }).success).toBe(false)
      expect(schema.safeParse({ ...input, purchaseOrderRef: "A\u0000B" }).success).toBe(false)
    }
  })

  it("accepts 200 characters after trimming and refuses 201 with a clear message", () => {
    for (const [schema, input] of cases) {
      expect(schema.parse({ ...input, purchaseOrderRef: `  ${"Æ".repeat(200)}  ` }).purchaseOrderRef).toBe("Æ".repeat(200))
      const refused = schema.safeParse({ ...input, purchaseOrderRef: `  ${"Æ".repeat(201)}  ` })
      expect(refused.success).toBe(false)
      if (!refused.success) expect(refused.error.issues).toContainEqual(expect.objectContaining({
        path: ["purchaseOrderRef"], message: "Order reference must be at most 200 characters after trimming",
      }))
    }
  })

  it.each([0, 1, 8, 11, 12, 14, 31, 0xd800, 0xdfff, 0xfffe, 0xffff])("rejects XML-forbidden character %i without silently changing the reference", code => {
    expect(purchaseOrderRefInputSchema.safeParse(`A${String.fromCharCode(code)}B`).success).toBe(false)
  })

  it("accepts XML text including Danish letters, escaped punctuation and supplementary Unicode", () => {
    const value = 'Ordre æøå ÆØÅ / <A&B> "7" \t\r\n \u0020\ud7ff\ue000\ufffd\u{10000}\u{10ffff}'
    expect(purchaseOrderRefInputSchema.parse(value)).toBe(value)
  })
})
