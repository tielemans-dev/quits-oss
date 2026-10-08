import { describe, expect, it } from "vitest"
import { invoiceCreateDraftInputSchema, invoiceCreateDraftV2InputSchema, invoiceUpdateDraftInputSchema, invoiceUpdateDraftV2InputSchema } from "./invoices"
import { quoteCreateDraftInputSchema, quoteCreateDraftV2InputSchema, quoteUpdateDraftInputSchema, quoteUpdateDraftV2InputSchema } from "./quotes"
import { recurringCreateInputSchema, recurringCreateV2InputSchema, recurringUpdateInputSchema, recurringUpdateV2InputSchema } from "./recurring"

const schemas = {
  invoiceCreateDraftInputSchema, invoiceCreateDraftV2InputSchema, invoiceUpdateDraftInputSchema, invoiceUpdateDraftV2InputSchema,
  quoteCreateDraftInputSchema, quoteCreateDraftV2InputSchema, quoteUpdateDraftInputSchema, quoteUpdateDraftV2InputSchema,
  recurringCreateInputSchema, recurringCreateV2InputSchema, recurringUpdateInputSchema, recurringUpdateV2InputSchema,
}
const line = (key?: string) => ({ key, description: "Work", quantity: "1", unitPrice: "100" })
const input = { id: "document", contactId: "contact", name: "Monthly", startDate: "2026-11-07", dueDate: "2026-11-07", expiryDate: "2026-11-07", supplyDate: "2026-11-07" }

for (const [name, schema] of Object.entries(schemas)) {
  describe(name, () => {
    it("rejects duplicate keys after trimming, with an issue on the repeated line", () => {
      const parsed = schema.safeParse({ ...input, items: [line("a"), line(" a ")] })
      expect(parsed.success).toBe(false)
      if (!parsed.success) expect(parsed.error.issues).toContainEqual(expect.objectContaining({ path: ["items", 1, "key"], code: "custom" }))
    })
    it("trims keys and rejects whitespace-only keys", () => {
      expect(schema.parse({ ...input, items: [line(" a ")] }).items?.[0]?.key).toBe("a")
      expect(schema.safeParse({ ...input, items: [line(" \t ")] }).success).toBe(false)
    })
    it("accepts unique keys and multiple lines without client keys", () => {
      expect(schema.safeParse({ ...input, items: [line("a"), line("b"), line(), line()] }).success).toBe(true)
    })
  })
}
