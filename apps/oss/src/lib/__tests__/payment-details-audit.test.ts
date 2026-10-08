import { describe, expect, it } from "vitest"
import type { PaymentDetails } from "@quits/contracts/payment-details"
import { diffPaymentDetails, formatChangedBy, maskPaymentDetail } from "../payment-details-audit"

const account = {
  accountHolder: "Nordic Design ApS",
  bankName: "Danske Bank",
  regNumber: "0040",
  accountNumber: "0440116243",
  iban: "DK5000400440116243",
  bic: "DABADKKK",
}
const details: PaymentDetails = { bankAccount: account, note: "MobilePay Box 12345" }
const none: PaymentDetails = { bankAccount: null, note: null }

describe("maskPaymentDetail", () => {
  it("keeps the country and the last four characters of an IBAN", () => {
    expect(maskPaymentDetail("iban", "DK5000400440116243")).toBe("DK****6243")
    expect(maskPaymentDetail("iban", "de89370400440532013000")).toBe("DE****3000")
  })

  it("keeps only the last four characters of an account number", () => {
    expect(maskPaymentDetail("accountNumber", "0440116243")).toBe("****6243")
    expect(maskPaymentDetail("accountNumber", "12345")).toBe("****2345")
  })

  it("never shows the middle of an IBAN", () => {
    const masked = maskPaymentDetail("iban", "DK5000400440116243")
    expect(masked).not.toContain("50")
    expect(masked).not.toContain("0040")
    expect(masked).not.toContain("0440")
  })

  it("masks a number of four characters or fewer completely", () => {
    expect(maskPaymentDetail("accountNumber", "1234")).toBe("****")
    expect(maskPaymentDetail("accountNumber", "7")).toBe("****")
    expect(maskPaymentDetail("iban", "DK50")).toBe("****")
  })

  it("only marks the payment note as set, because free text can hold an account number", () => {
    expect(maskPaymentDetail("note", "Pay to account 0440116243")).toBe("****")
  })

  it("leaves reg.nr., BIC, account holder and bank name readable", () => {
    expect(maskPaymentDetail("regNumber", "0040")).toBe("0040")
    expect(maskPaymentDetail("bic", "DABADKKK")).toBe("DABADKKK")
    expect(maskPaymentDetail("accountHolder", "Nordic Design ApS")).toBe("Nordic Design ApS")
    expect(maskPaymentDetail("bankName", "Danske Bank")).toBe("Danske Bank")
  })

  it("turns a missing or blank value into null", () => {
    for (const field of ["iban", "accountNumber", "note", "bic"] as const) {
      expect(maskPaymentDetail(field, null)).toBeNull()
      expect(maskPaymentDetail(field, undefined)).toBeNull()
      expect(maskPaymentDetail(field, "  ")).toBeNull()
    }
  })
})

describe("formatChangedBy", () => {
  it("shows the name and the account email", () => {
    expect(formatChangedBy({ name: "Mette Admin", email: "mette@example.com" })).toBe("Mette Admin <mette@example.com>")
  })

  it("shows only the name when there is no email (an agent or the system)", () => {
    expect(formatChangedBy({ name: "Invoice bot", email: null })).toBe("Invoice bot")
  })

  it("keeps a chosen name on one line and short, so it cannot pass for something else", () => {
    expect(formatChangedBy({ name: "CEO\nNew bank:\u202e  ", email: "x@example.com" })).toBe("CEO New bank: <x@example.com>")
    expect(formatChangedBy({ name: "x".repeat(200), email: null })).toHaveLength(80)
  })
})

describe("diffPaymentDetails", () => {
  it("reports nothing when nothing changed", () => {
    expect(diffPaymentDetails(details, details)).toEqual([])
    expect(diffPaymentDetails(none, none)).toEqual([])
    expect(diffPaymentDetails(none, { bankAccount: null, note: "  " })).toEqual([])
    expect(diffPaymentDetails(none, { bankAccount: {} as never, note: null })).toEqual([])
  })

  it("lists only the changed fields, masked, in field order", () => {
    const after: PaymentDetails = {
      bankAccount: { ...account, iban: "DE89370400440532013000", bic: "COBADEFF", bankName: "Commerzbank" },
      note: details.note,
    }
    expect(diffPaymentDetails(details, after)).toEqual([
      { field: "bankName", before: "Danske Bank", after: "Commerzbank" },
      { field: "iban", before: "DK****6243", after: "DE****3000" },
      { field: "bic", before: "DABADKKK", after: "COBADEFF" },
    ])
  })

  it("records a first account as coming from nothing, and a removed one as going to nothing", () => {
    expect(diffPaymentDetails(none, details)).toEqual([
      { field: "accountHolder", before: null, after: "Nordic Design ApS" },
      { field: "bankName", before: null, after: "Danske Bank" },
      { field: "regNumber", before: null, after: "0040" },
      { field: "accountNumber", before: null, after: "****6243" },
      { field: "iban", before: null, after: "DK****6243" },
      { field: "bic", before: null, after: "DABADKKK" },
      { field: "note", before: null, after: "****" },
    ])
    expect(diffPaymentDetails(details, none)).toContainEqual({ field: "iban", before: "DK****6243", after: null })
  })

  it("lists a changed note even though its content is hidden", () => {
    expect(diffPaymentDetails(details, { ...details, note: "Other" })).toEqual([
      { field: "note", before: "****", after: "****" },
    ])
  })

  it("never contains a full IBAN or account number", () => {
    const serialized = JSON.stringify(diffPaymentDetails(none, details)) + JSON.stringify(diffPaymentDetails(details, none))
    expect(serialized).not.toContain(account.iban)
    expect(serialized).not.toContain(account.accountNumber)
    expect(serialized).not.toContain("MobilePay")
  })
})
