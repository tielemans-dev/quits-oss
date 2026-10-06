import { describe, expect, it } from "vitest"
import {
  invoicePaymentTokenPayloadSchema,
  paymentRecordInputSchema,
  paymentVoidInputSchema,
  publicInvoiceCheckoutResultSchema,
  publicInvoiceTokenInputSchema,
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
