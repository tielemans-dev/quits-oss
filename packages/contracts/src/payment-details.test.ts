import { describe, expect, it } from "vitest"
import {
  EMPTY_PAYMENT_DETAILS,
  formatIban,
  hasPaymentDetails,
  isValidBic,
  isValidIban,
  normalizeIban,
  paymentDetailsInputSchema,
} from "./payment-details"
import { parseSellerSnapshot } from "./documents"

/** A valid Danish IBAN: DK, check digits 50, reg.nr. 0040, account number 0440116243. */
const DANISH_IBAN = "DK5000400440116243"

describe("IBAN validation", () => {
  it("accepts the Danish sample IBAN", () => {
    expect(isValidIban(DANISH_IBAN)).toBe(true)
  })

  it("rejects an IBAN with a corrupted digit", () => {
    expect(isValidIban("DK5000400440116244")).toBe(false)
    expect(isValidIban("DK5100400440116243")).toBe(false)
  })

  it("accepts spaced and lower case input", () => {
    expect(isValidIban("DK50 0040 0440 1162 43")).toBe(true)
    expect(isValidIban("dk5000400440116243")).toBe(true)
    expect(isValidIban("  dk50 0040 0440 1162 43  ")).toBe(true)
  })

  it.each([
    ["GB82 WEST 1234 5698 7654 32"],
    ["DE89 3704 0044 0532 0130 00"],
    ["FR14 2004 1010 0505 0001 3M02 606"],
    ["NO93 8601 1117 947"],
  ])("accepts the published sample IBAN %s", (iban) => {
    expect(isValidIban(iban)).toBe(true)
  })

  it.each([
    [""],
    ["DK50"],
    ["5000400440116243"],
    ["DK50-0040-0440-1162-43"],
    ["DK5000400440116243999999999999999999999"],
    ["1K5000400440116243"],
  ])("rejects a malformed IBAN %j", (iban) => {
    expect(isValidIban(iban)).toBe(false)
  })

  it("normalizes and formats", () => {
    expect(normalizeIban(" dk50 0040 0440 1162 43 ")).toBe(DANISH_IBAN)
    expect(formatIban(DANISH_IBAN)).toBe("DK50 0040 0440 1162 43")
    expect(formatIban("dk50 0040 0440 1162 43")).toBe("DK50 0040 0440 1162 43")
  })
})

describe("BIC validation", () => {
  it.each([["DABADKKK"], ["DABADKKKXXX"], ["nykbdkkk"], ["DAB ADK KK"]])("accepts %j", (bic) => {
    expect(isValidBic(bic)).toBe(true)
  })

  it.each([[""], ["DABADKK"], ["DABADKKKXX"], ["1ABADKKK"], ["DABADKKKXXXX"], ["DABA-DKKK"]])(
    "rejects %j",
    (bic) => {
      expect(isValidBic(bic)).toBe(false)
    }
  )
})

describe("payment details input", () => {
  it("accepts a complete set of details and normalizes them", () => {
    expect(
      paymentDetailsInputSchema.parse({
        accountHolder: "  Acme ApS ",
        bankName: "Danske Bank",
        regNumber: " 0040 ",
        accountNumber: "0440 116243",
        iban: "dk50 0040 0440 1162 43",
        bic: " dabadkkk ",
        note: "MobilePay Box 12345",
      })
    ).toEqual({
      accountHolder: "Acme ApS",
      bankName: "Danske Bank",
      regNumber: "0040",
      accountNumber: "0440116243",
      iban: DANISH_IBAN,
      bic: "DABADKKK",
      note: "MobilePay Box 12345",
    })
  })

  it("makes every field optional and turns empty values into null", () => {
    expect(paymentDetailsInputSchema.parse({})).toEqual(EMPTY_PAYMENT_DETAILS)
    expect(
      paymentDetailsInputSchema.parse({
        accountHolder: "",
        bankName: "   ",
        regNumber: "",
        accountNumber: "",
        iban: " ",
        bic: "",
        note: "",
      })
    ).toEqual(EMPTY_PAYMENT_DETAILS)
    expect(paymentDetailsInputSchema.parse({ iban: null, note: null })).toEqual(EMPTY_PAYMENT_DETAILS)
  })

  it("accepts an international-only setup without Danish account numbers", () => {
    expect(paymentDetailsInputSchema.parse({ iban: DANISH_IBAN, bic: "DABADKKK" })).toMatchObject({
      iban: DANISH_IBAN,
      regNumber: null,
      accountNumber: null,
    })
  })

  it.each([["123"], ["12345"], ["12a4"], ["12-4"]])("rejects the reg.nr. %j", (regNumber) => {
    const result = paymentDetailsInputSchema.safeParse({ regNumber, accountNumber: "1234567" })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues.map((issue) => issue.path[0])).toContain("regNumber")
  })

  it.each([["12345678901"], ["12a"], ["1-2"]])("rejects the account number %j", (accountNumber) => {
    const result = paymentDetailsInputSchema.safeParse({ regNumber: "0040", accountNumber })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues.map((issue) => issue.path[0])).toContain("accountNumber")
  })

  it("accepts account numbers from one to ten digits", () => {
    expect(paymentDetailsInputSchema.safeParse({ regNumber: "0040", accountNumber: "1" }).success).toBe(true)
    expect(paymentDetailsInputSchema.safeParse({ regNumber: "0040", accountNumber: "1234567890" }).success).toBe(true)
  })

  it("requires the reg.nr. and account number together", () => {
    const onlyReg = paymentDetailsInputSchema.safeParse({ regNumber: "0040" })
    expect(onlyReg.success).toBe(false)
    if (!onlyReg.success) expect(onlyReg.error.issues.map((issue) => issue.path[0])).toEqual(["accountNumber"])

    const onlyAccount = paymentDetailsInputSchema.safeParse({ accountNumber: "0440116243" })
    expect(onlyAccount.success).toBe(false)
    if (!onlyAccount.success) expect(onlyAccount.error.issues.map((issue) => issue.path[0])).toEqual(["regNumber"])

    // A blank counterpart is the same as a missing one.
    expect(paymentDetailsInputSchema.safeParse({ regNumber: "0040", accountNumber: "  " }).success).toBe(false)
  })

  it("rejects a corrupted IBAN and a malformed BIC", () => {
    const corrupted = paymentDetailsInputSchema.safeParse({ iban: "DK5000400440116244" })
    expect(corrupted.success).toBe(false)
    if (!corrupted.success) expect(corrupted.error.issues[0]?.path).toEqual(["iban"])

    const bic = paymentDetailsInputSchema.safeParse({ bic: "DABADKK" })
    expect(bic.success).toBe(false)
    if (!bic.success) expect(bic.error.issues[0]?.path).toEqual(["bic"])
  })

  it("limits the payment note to 500 characters", () => {
    expect(paymentDetailsInputSchema.safeParse({ note: "x".repeat(500) }).success).toBe(true)
    const tooLong = paymentDetailsInputSchema.safeParse({ note: "x".repeat(501) })
    expect(tooLong.success).toBe(false)
    if (!tooLong.success) expect(tooLong.error.issues[0]?.path).toEqual(["note"])
  })

  it("limits the account holder and bank name", () => {
    expect(paymentDetailsInputSchema.safeParse({ accountHolder: "x".repeat(121) }).success).toBe(false)
    expect(paymentDetailsInputSchema.safeParse({ bankName: "x".repeat(121) }).success).toBe(false)
  })

  it("reports whether any detail is filled in", () => {
    expect(hasPaymentDetails(null)).toBe(false)
    expect(hasPaymentDetails(EMPTY_PAYMENT_DETAILS)).toBe(false)
    expect(hasPaymentDetails({ note: "  " })).toBe(false)
    expect(hasPaymentDetails({ note: "MobilePay Box 12345" })).toBe(true)
  })
})

describe("seller snapshot bank details", () => {
  it("keeps parsing snapshots issued before bank details existed", () => {
    expect(parseSellerSnapshot({ companyName: "Acme", taxIds: [] })).toEqual({
      companyName: "Acme",
      taxIds: [],
    })
  })

  it("parses frozen bank details", () => {
    const bankDetails = { iban: DANISH_IBAN, bic: "DABADKKK", regNumber: "0040", accountNumber: "0440116243" }
    expect(parseSellerSnapshot({ companyName: "Acme", bankDetails })?.bankDetails).toEqual(bankDetails)
    expect(parseSellerSnapshot({ companyName: "Acme", bankDetails: null })?.bankDetails).toBeNull()
  })

  it("reads stored bank details leniently", () => {
    // Values were validated on the way in; an old snapshot is never re-validated.
    expect(parseSellerSnapshot({ bankDetails: { iban: "not an iban", regNumber: "12" } })?.bankDetails).toEqual({
      iban: "not an iban",
      regNumber: "12",
    })
  })
})
