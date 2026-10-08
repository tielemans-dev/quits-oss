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

  it("draws the partial rule for credits alone, whatever the payment status says", () => {
    expect(
      invoiceAmountRule({ status: "sent", paymentStatus: "unpaid", total: 100, balanceDue: 60 })
    ).toEqual({ rule: "double", paidFraction: 0.4 })
  })

  it("counts credits and payments together", () => {
    // Total 100, credited 40, paid 25: 35 is left, so 65% is settled.
    const { rule, paidFraction } = invoiceAmountRule({
      status: "viewed",
      paymentStatus: "partially_paid",
      total: 100,
      balanceDue: 35,
    })
    expect(rule).toBe("double")
    expect(paidFraction).toBeCloseTo(0.65, 10)
  })

  it("draws two full rules for an invoice credited down to nothing", () => {
    expect(
      invoiceAmountRule({ status: "sent", paymentStatus: "unpaid", total: 100, balanceDue: 0 })
    ).toEqual({ rule: "double" })
  })

  it("keeps an untouched invoice at one rule, and never divides by a zero total", () => {
    expect(invoiceAmountRule({ status: "sent", paymentStatus: "unpaid", total: 100, balanceDue: 100 })).toEqual({ rule: "single" })
    expect(invoiceAmountRule({ status: "sent", paymentStatus: "unpaid", total: 0, balanceDue: 0 })).toEqual({ rule: "single" })
  })
})
