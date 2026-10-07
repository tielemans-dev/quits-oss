import { describe, expect, it } from "vitest"
import { computeSettlement, settledInvoiceStatus } from "../documents/settlement"

describe("invoice settlement", () => {
  it("tracks partial and full payment", () => {
    expect(computeSettlement({ totalGross: 100, amountPaid: 0, amountCredited: 0 })).toMatchObject({
      paymentStatus: "unpaid",
    })
    const partial = computeSettlement({ totalGross: 100, amountPaid: 40, amountCredited: 0 })
    expect(partial.paymentStatus).toBe("partially_paid")
    expect(partial.balanceDue.toNumber()).toBe(60)
    expect(computeSettlement({ totalGross: 100, amountPaid: 100, amountCredited: 0 }).paymentStatus).toBe("paid")
  })

  it("lets credit notes reduce what is owed", () => {
    const credited = computeSettlement({ totalGross: 100, amountPaid: 70, amountCredited: 30 })
    expect(credited.paymentStatus).toBe("paid")
    expect(credited.balanceDue.toNumber()).toBe(0)

    const fully = computeSettlement({ totalGross: 100, amountPaid: 0, amountCredited: 100 })
    expect(fully.fullyCredited).toBe(true)
    expect(fully.paymentStatus).toBe("unpaid")
  })

  it("never reports a negative balance on overpayment", () => {
    expect(computeSettlement({ totalGross: 100, amountPaid: 120, amountCredited: 0 }).balanceDue.toNumber()).toBe(0)
  })

  it("reopens paid invoices when a payment is voided", () => {
    const now = new Date("2026-10-06")
    const unpaid = computeSettlement({ totalGross: 100, amountPaid: 0, amountCredited: 0 })
    expect(
      settledInvoiceStatus({ currentStatus: "paid", dueDate: new Date("2026-10-01"), now, settlement: unpaid })
    ).toBe("overdue")
    expect(
      settledInvoiceStatus({ currentStatus: "paid", dueDate: new Date("2026-11-01"), now, settlement: unpaid })
    ).toBe("sent")
    expect(
      settledInvoiceStatus({ currentStatus: "draft", dueDate: now, now, settlement: unpaid })
    ).toBe("draft")
  })
})
