import { describe, expect, it } from "vitest"
import {
  invoicePaymentTokenPayloadSchema,
  paymentRecordInputSchema,
  paymentVoidInputSchema,
  publicInvoiceCheckoutResultSchema,
  publicInvoiceTokenInputSchema,
  settlementEvidenceSchema,
} from "./payments"

describe("payments contracts", () => {
  it("parses token input and invoice payment payloads", () => {
    const input = publicInvoiceTokenInputSchema.parse({
      token: "signed-token",
    })
    const payload = invoicePaymentTokenPayloadSchema.parse({
      invoiceId: "inv_123",
      keyVersion: 1,
      scope: "invoice_payment",
    })

    expect(input.token).toBe("signed-token")
    expect(payload.scope).toBe("invoice_payment")
  })

  it("accepts typed public checkout results", () => {
    const parsed = publicInvoiceCheckoutResultSchema.parse({
      status: "redirect",
      url: "https://app.example.test/pay/signed-token",
    })

    expect(parsed.status).toBe("redirect")
  })

  it("validates payment amounts to two positive decimals", () => {
    const base = { invoiceId: "inv_1", paidAt: "2026-10-01", method: "bank_transfer" }
    expect(paymentRecordInputSchema.safeParse({ ...base, amount: 19.99 }).success).toBe(true)
    expect(paymentRecordInputSchema.safeParse({ ...base, amount: 0 }).success).toBe(false)
    expect(paymentRecordInputSchema.safeParse({ ...base, amount: -5 }).success).toBe(false)
    expect(paymentRecordInputSchema.safeParse({ ...base, amount: 1.005 }).success).toBe(false)
    expect(paymentRecordInputSchema.safeParse({ ...base, amount: 10, method: "cheque" }).success).toBe(
      false
    )
    expect(paymentRecordInputSchema.safeParse({ ...base, amount: 10, paidAt: "nope" }).success).toBe(
      false
    )
  })

  it("requires a reason to void a payment", () => {
    expect(paymentVoidInputSchema.safeParse({ paymentId: "pay_1", reason: "  " }).success).toBe(false)
    expect(paymentVoidInputSchema.safeParse({ paymentId: "pay_1", reason: "Bounced" }).success).toBe(true)
  })
})

describe("settlement evidence", () => {
  it.each([
    "https://operator:credential@example.test/statement",
    "https://operator@example.test/statement",
    "https://:credential@example.test/statement",
  ])("refuses embedded credentials in %s", (evidence) => {
    expect(settlementEvidenceSchema.safeParse({ reason: "Statement", evidence }).success).toBe(false)
  })

  it.each(["\u0000", "\t", "\n", "\r", "\u001f", "\u007f", "\u0085"])(
    "refuses raw control characters before trimming or URL normalization (%j)",
    (control) => {
      for (const evidence of [
        `${control}https://example.test/statement`,
        `https://exam${control}ple.test/statement`,
        `https://example.test/statement${control}`,
      ]) {
        expect(settlementEvidenceSchema.safeParse({ reason: "Statement", evidence }).success).toBe(false)
      }
    },
  )

  it.each([
    "http://example.test/statement",
    "https://example.test/statement?sig=intentionally-shared&expires=123#receipt",
    "https://localhost/statement",
    "https://example.test/statement%0A1",
  ])("keeps intentionally shared HTTP(S) evidence links (%s)", (evidence) => {
    expect(settlementEvidenceSchema.parse({ reason: " Statement ", evidence: ` ${evidence} ` }))
      .toEqual({ reason: "Statement", evidence })
  })

  it.each(["javascript:alert(1)", "data:text/html,test", "ftp://example.test/statement", "https:/example.test", "not a URL"])(
    "refuses invalid or non-HTTP(S) evidence (%s)",
    (evidence) => {
      expect(settlementEvidenceSchema.safeParse({ reason: "Statement", evidence }).success).toBe(false)
    },
  )
})
