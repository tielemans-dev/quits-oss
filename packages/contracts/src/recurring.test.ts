import { describe, expect, it } from "vitest"
import { recurringCreateInputSchema, recurringUpdateInputSchema } from "./recurring"

const base = {
  name: "Retainer",
  contactId: "contact_1",
  items: [{ description: "Retainer", quantity: 1, unitPrice: 100 }],
  startDate: "2026-01-31",
}

describe("recurring contracts", () => {
  it("applies schedule defaults", () => {
    expect(recurringCreateInputSchema.parse(base)).toMatchObject({
      taxRate: 0,
      intervalCount: 1,
      intervalUnit: "month",
      dueInDays: 14,
      autoSend: false,
      end: { type: "none" },
    })
  })

  it("rejects impossible calendar dates and out-of-range cadences", () => {
    expect(recurringCreateInputSchema.safeParse({ ...base, startDate: "2026-02-30" }).success).toBe(false)
    expect(recurringCreateInputSchema.safeParse({ ...base, intervalCount: 13 }).success).toBe(false)
    expect(recurringCreateInputSchema.safeParse({ ...base, dueInDays: 121 }).success).toBe(false)
  })

  it("keeps omitted fields undefined on update", () => {
    expect(recurringUpdateInputSchema.parse({ id: "rec_1", autoSend: true })).toEqual({
      id: "rec_1",
      autoSend: true,
    })
  })
})
