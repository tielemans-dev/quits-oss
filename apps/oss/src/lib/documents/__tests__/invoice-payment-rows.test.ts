import { describe, expect, it } from "vitest"
import { groupAccountNumber, invoicePaymentRows } from "../invoice-payment-rows"

describe("invoice transfer display", () => {
  it("groups ten digits without changing leading zeroes or legacy account values", () => {
    expect(groupAccountNumber("0440116243")).toBe("0440 116 243")
    expect(groupAccountNumber(" 0123456789 ")).toBe("0123 456 789")
    for (const value of ["1234567", "0001-2345", "0440 116 243", "<script>"]) expect(groupAccountNumber(value)).toBe(value)
  })

  it.each([
    ["  ORDER-2026-42  ", "ORDER-2026-42"],
    ["  ", "INV-0042"],
    [null, "INV-0042"],
  ])("uses the stored reference or invoice-number fallback: %s", (paymentReference, expected) => {
    const rows = invoicePaymentRows({ number: "INV-0042", paymentReference, total: 250, currency: "DKK", dueDate: "2026-03-23" }, "en-US")
    expect(rows.find(row => row.key === "email.pay.referenceLabel")?.value).toBe(expected)
  })

  it("does not invent a draft payment message or missing bank rows", () => {
    const rows = invoicePaymentRows({ number: null, total: 250, currency: "DKK", dueDate: "2026-03-23" }, "da-DK")
    expect(rows).toEqual([
      { key: "email.pay.amount", label: "Beløb", value: "250,00\u00a0kr." },
      { key: "email.pay.due", label: "Forfaldsdato", value: "23. mar. 2026" },
    ])
  })
})
