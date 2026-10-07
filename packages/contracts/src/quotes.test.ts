import { describe, expect, it } from "vitest"
import {
  publicQuoteDecisionInputSchema,
  quotePublicDecisionStateSchema,
  quoteCreateDraftInputSchema,
  quotePublicTokenPayloadSchema,
  quoteUpdateDraftInputSchema,
} from "./quotes"

describe("quote contracts", () => {
  it("parses public quote token payloads", () => {
    const payload = quotePublicTokenPayloadSchema.parse({
      quoteId: "quo_123",
      keyVersion: 2,
      scope: "quote_public",
    })

    expect(payload.scope).toBe("quote_public")
  })

  it("parses public quote decision inputs", () => {
    const parsed = publicQuoteDecisionInputSchema.parse({
      token: "signed-token",
      decision: "accepted",
    })

    expect(parsed.decision).toBe("accepted")
    expect(quotePublicDecisionStateSchema.parse("pending")).toBe("pending")
  })

  it("defaults the tax rate on draft quotes and rejects empty line lists", () => {
    const parsed = quoteCreateDraftInputSchema.parse({
      contactId: "contact_1",
      expiryDate: "2026-12-01",
      items: [{ description: "Design", quantity: 1, unitPrice: 100 }],
    })
    expect(parsed.taxRate).toBe(0)
    expect(
      quoteCreateDraftInputSchema.safeParse({ ...parsed, items: [] }).success
    ).toBe(false)
    expect(quoteUpdateDraftInputSchema.safeParse({ id: "q_1", expiryDate: "not a date" }).success).toBe(
      false
    )
  })
})
