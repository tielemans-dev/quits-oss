import { describe, expect, it } from "vitest"

import { invoiceAmountRule } from "../payments/invoice-display-status"

const base = { paymentStatus: "unpaid", total: 1000, balanceDue: 1000 }

describe("invoiceAmountRule", () => {
  it("draws no rule under a draft", () => {
    expect(invoiceAmountRule({ ...base, status: "draft" })).toEqual({ rule: "none" })
  })

  it("draws one rule while the money is asked for", () => {
    for (const status of ["sent", "viewed", "overdue"]) {
      expect(invoiceAmountRule({ ...base, status })).toEqual({ rule: "single" })
    }
  })

  it("draws two rules once it is paid or credited", () => {
    expect(invoiceAmountRule({ ...base, status: "paid", paymentStatus: "paid", balanceDue: 0 })).toEqual({ rule: "double" })
    expect(invoiceAmountRule({ ...base, status: "credited", balanceDue: 0 })).toEqual({ rule: "double" })
  })

  it("draws the second rule as far as the settled share for a part payment", () => {
    expect(
      invoiceAmountRule({ status: "sent", paymentStatus: "partially_paid", total: 12000, balanceDue: 7500 })
    ).toEqual({ rule: "double", paidFraction: 0.375 })
  })

  it("keeps a part-paid overdue invoice overdue but still shows the money received", () => {
    expect(
      invoiceAmountRule({ status: "overdue", paymentStatus: "partially_paid", total: 100, balanceDue: 25 })
    ).toEqual({ rule: "double", paidFraction: 0.75 })
  })

  it("does not divide by a zero total", () => {
    expect(
      invoiceAmountRule({ status: "sent", paymentStatus: "partially_paid", total: 0, balanceDue: 0 })
    ).toEqual({ rule: "double", paidFraction: 0 })
  })
})
