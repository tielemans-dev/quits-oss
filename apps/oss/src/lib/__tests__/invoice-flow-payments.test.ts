import { describe, expect, it } from "vitest"
import { invoiceCreateDraftV2InputSchema } from "@quits/contracts/invoices"
import { withInvoicePaymentDetails } from "../../domain/documents/snapshots"
import { invoiceAllowsPayment } from "../payments/invoice-methods"

describe("invoice payment selection", () => {
  it("retains historical methods and freezes only a selected bank destination", () => {
    expect(invoiceAllowsPayment(null, "card")).toBe(true)
    expect(invoiceAllowsPayment(["bank_transfer"], "card")).toBe(false)
    const bank = { bankRegNumber: "0040", bankAccountNumber: "0440116243" }
    expect(withInvoicePaymentDetails({}, bank, "da-DK", ["bank_transfer"])).toHaveProperty("bankAccount")
    expect(withInvoicePaymentDetails({}, bank, "da-DK", ["card"])).not.toHaveProperty("bankAccount")
  })
  it("rejects unsupported payment options and accepts reminder preferences", () => {
    const input = { contactId: "buyer", dueDate: "2026-11-01", supplyDate: "2026-10-15", items: [{ description: "Consulting", quantity: "1", unitPrice: "100" }], remindersPaused: true }
    expect(invoiceCreateDraftV2InputSchema.safeParse({ ...input, paymentMethods: ["mobilepay"] }).success).toBe(false)
    expect(invoiceCreateDraftV2InputSchema.parse({ ...input, paymentMethods: ["bank_transfer"] }).remindersPaused).toBe(true)
  })
})
