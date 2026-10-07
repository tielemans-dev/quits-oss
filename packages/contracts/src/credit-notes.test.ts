import { describe, expect, it } from "vitest"
import { creditNoteIssueInputSchema } from "./credit-notes"

describe("credit note contracts", () => {
  it("parses each issue mode", () => {
    expect(creditNoteIssueInputSchema.parse({ invoiceId: "inv_1", reason: "Refund", mode: "full" })).toEqual({
      invoiceId: "inv_1",
      reason: "Refund",
      mode: "full",
    })
    expect(
      creditNoteIssueInputSchema.parse({
        invoiceId: "inv_1",
        reason: " Damaged ",
        mode: "lines",
        lines: [{ invoiceItemId: "item_1", quantity: 1.5 }],
      })
    ).toMatchObject({ reason: "Damaged", lines: [{ quantity: 1.5 }] })
    expect(
      creditNoteIssueInputSchema.parse({ invoiceId: "inv_1", reason: "Goodwill", mode: "amount", amount: 25.5 })
    ).toMatchObject({ mode: "amount", amount: 25.5 })
  })

  it("requires a reason and rejects invalid amounts", () => {
    const base = { invoiceId: "inv_1", mode: "amount", amount: 10 }
    expect(creditNoteIssueInputSchema.safeParse({ ...base, reason: "  " }).success).toBe(false)
    expect(creditNoteIssueInputSchema.safeParse({ ...base, reason: "x".repeat(501) }).success).toBe(false)
    expect(creditNoteIssueInputSchema.safeParse({ ...base, reason: "ok", amount: 0 }).success).toBe(false)
    expect(creditNoteIssueInputSchema.safeParse({ ...base, reason: "ok", amount: 1.234 }).success).toBe(false)
    expect(
      creditNoteIssueInputSchema.safeParse({ invoiceId: "inv_1", reason: "ok", mode: "lines", lines: [] }).success
    ).toBe(false)
  })
})
