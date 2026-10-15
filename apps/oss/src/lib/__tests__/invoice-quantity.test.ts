import { describe, expect, it } from "vitest"
import { invoiceCreateDraftV2InputSchema, invoiceUpdateDraftV2InputSchema, quantityDecimalSchema } from "@quits/contracts/invoices"
import { previewDraft } from "@quits/shared/pricing"
import { invoiceQuantityInput, localizeInvoiceQuantity, normalizeInvoiceQuantity } from "../invoice-quantity"

const LOCALES = ["da-DK", "en-US"] as const

describe("invoice editor quantities", () => {
  it.each([
    ["1,5", "1.5"], ["0,123456", "0.123456"], ["0,000001", "0.000001"],
    ["1000000,000000", "1000000.000000"], ["1.5", "1.5"], ["1000000", "1000000"],
  ])("accepts %s without losing decimal precision", (raw, canonical) => {
    for (const locale of LOCALES) expect(invoiceQuantityInput(locale).parse(raw)).toBe(canonical)
  })

  it.each([
    ["en-US", "1,000"], ["en-US", "12,500"], ["da-DK", "1.000"], ["da-DK", "12.500"],
  ])("rejects %s grouped quantity %s instead of saving it 1000x too small", (locale, raw) => {
    expect(invoiceQuantityInput(locale).safeParse(raw).success).toBe(false)
    const item = { quantity: raw }
    expect(normalizeInvoiceQuantity(item, locale)).toBe(item)
  })

  it.each([
    ["da-DK", "1,000", "1.000"], ["en-US", "1.000", "1.000"], ["da-DK", "2.5", "2.5"], ["en-US", "2,5", "2.5"],
    ["da-DK", "0.125", "0.125"], ["en-US", "0,125", "0.125"], ["da-DK", "1000.500", "1000.500"],
  ])("reads the decimal separator for %s %s", (locale, raw, canonical) => {
    expect(invoiceQuantityInput(locale).parse(raw)).toBe(canonical)
  })

  it.each([
    "1e3", "1E+3", "1e", "1,5e3", "0", "0,000000", "-1", "1000001",
    "1000000,000001", "0,1234567", "0.1234567", "1,5.0", "1.000,5",
    "1,000,000", "1.000.000", "1,", ",5", " 1,5", "1,5 ", "NaN", "Infinity",
    "0".repeat(40) + ",1",
  ])("rejects %s before preview or submission", raw => {
    const item = { quantity: raw }
    for (const locale of LOCALES) {
      expect(invoiceQuantityInput(locale).safeParse(raw).success).toBe(false)
      expect(normalizeInvoiceQuantity(item, locale)).toBe(item)
    }
    expect(quantityDecimalSchema.safeParse(raw).success).toBe(false)
  })

  it.each(["1.000", "0.125", "1.5", "1000000", "2.500000"])("round-trips persisted %s through the Danish and English editors", canonical => {
    for (const locale of LOCALES) {
      expect(invoiceQuantityInput(locale).parse(localizeInvoiceQuantity(canonical, locale))).toBe(canonical)
    }
  })

  it("submits canonical quantities through both create and edit schemas", () => {
    const raw = { description: "Synthetic test work", quantity: "1,5", unitPrice: "100" }
    const items = [normalizeInvoiceQuantity(raw, "da-DK")]
    const create = { contactId: "test-contact", dueDate: "2026-10-15", supplyDate: "2026-10-13", items }
    const edit = { id: "test-invoice", items }
    expect(invoiceCreateDraftV2InputSchema.parse(create).items[0]?.quantity).toBe("1.5")
    expect(invoiceUpdateDraftV2InputSchema.parse(edit).items?.[0]?.quantity).toBe("1.5")
    // The API contract stays strict; locale normalization belongs to the editor.
    expect(invoiceCreateDraftV2InputSchema.safeParse({ ...create, items: [raw] }).success).toBe(false)
    expect(invoiceUpdateDraftV2InputSchema.safeParse({ ...edit, items: [raw] }).success).toBe(false)
    expect(raw.quantity).toBe("1,5")
  })

  it("previews comma and point quantities identically", () => {
    const item = { description: "Synthetic test work", quantity: "1,5", unitPrice: "100" }
    const input = { currency: "DKK", taxRate: "25", pricesIncludeTax: false }
    const comma = previewDraft({ ...input, items: [normalizeInvoiceQuantity(item, "da-DK")] })
    const point = previewDraft({ ...input, items: [{ ...item, quantity: "1.5" }] })
    expect(comma.result?.net).toBe("150.00")
    expect(comma).toEqual(point)
    expect(previewDraft({ ...input, items: [normalizeInvoiceQuantity({ ...item, quantity: "1,5e3" }, "da-DK")] }).result).toBeNull()
  })
})
