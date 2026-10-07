import { describe, expect, it } from "vitest"
import { Prisma } from "../../../../generated/prisma/client"
import { presentInvoice } from "../tools/documents"

const decimal = (value: number) => new Prisma.Decimal(value)

function invoiceRow(amounts: { totalGross: number; amountPaid: number; amountCredited: number }) {
  return {
    id: "inv_1",
    number: "INV-0001",
    status: "paid",
    paymentStatus: "paid",
    contactId: "contact_1",
    issueDate: new Date("2026-01-01T00:00:00Z"),
    dueDate: new Date("2026-01-15T00:00:00Z"),
    currency: "USD",
    subtotalNet: decimal(amounts.totalGross),
    totalTax: decimal(0),
    totalGross: decimal(amounts.totalGross),
    amountPaid: decimal(amounts.amountPaid),
    amountCredited: decimal(amounts.amountCredited),
    publicPaymentIssuedAt: null,
    publicPaymentKeyVersion: 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  }
}

describe("presentInvoice", () => {
  it("never shows agents a negative balance after an overpayment", () => {
    const presented = presentInvoice(invoiceRow({ totalGross: 100, amountPaid: 120, amountCredited: 0 }))
    expect(presented.balanceDue.toFixed(2)).toBe("0.00")
  })

  it("does not count a credit and a payment for the same money twice", () => {
    const presented = presentInvoice(invoiceRow({ totalGross: 100, amountPaid: 100, amountCredited: 50 }))
    expect(presented.balanceDue.toFixed(2)).toBe("0.00")
  })

  it("shows what is still owed after partial payments and credits", () => {
    const presented = presentInvoice(invoiceRow({ totalGross: 100, amountPaid: 30, amountCredited: 20 }))
    expect(presented.balanceDue.toFixed(2)).toBe("50.00")
  })
})
