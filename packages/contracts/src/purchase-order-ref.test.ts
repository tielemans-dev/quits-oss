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
      for (const purchaseOrderRef of [null, "", "   "]) {
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

  it("rejects all control characters and Unicode format characters before trimming", () => {
    const controls = [...Array.from({ length: 32 }, (_, code) => code), ...Array.from({ length: 33 }, (_, index) => 0x7f + index)]
    const formats = [0xad, 0x61c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c,
      0x202d, 0x202e, 0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff, 0xfff9, 0x1bca0, 0xe0001]
    for (const code of [...controls, ...formats]) {
      const char = String.fromCodePoint(code)
      // Covers invisible-only identifiers and characters trim() would silently remove at either end.
      for (const purchaseOrderRef of [char, `${char}PO-42`, `PO-42${char}`, `PO-${char}42`]) {
        for (const [schema, input] of cases) {
          const refused = schema.safeParse({ ...input, purchaseOrderRef })
          expect(refused.success).toBe(false)
          if (!refused.success) expect(refused.error.issues).toContainEqual(expect.objectContaining({
            path: ["purchaseOrderRef"], message: "Order reference must not contain control or format characters",
          }))
        }
      }
    }
  })

  it.each([0, 1, 8, 11, 12, 14, 31, 0xd800, 0xdfff, 0xfffe, 0xffff])("rejects XML-forbidden character %i without silently changing the reference", code => {
    expect(purchaseOrderRefInputSchema.safeParse(`A${String.fromCharCode(code)}B`).success).toBe(false)
  })

  it("accepts XML text including Danish letters, escaped punctuation and supplementary Unicode", () => {
    const value = 'Ordre æøå ÆØÅ / <A&B> "7" \u0020\ud7ff\ue000\ufffd\u{10000}\u{10ffff}'
    expect(purchaseOrderRefInputSchema.parse(value)).toBe(value)
  })
})
