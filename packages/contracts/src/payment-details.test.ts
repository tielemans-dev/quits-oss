import { describe, expect, it } from "vitest"
import {
  EMPTY_PAYMENT_DETAILS,
  IBAN_LENGTH_BY_COUNTRY,
  bankAccountSchema,
  formatIban,
  hasBankAccount,
  hasPaymentDetails,
  isValidBic,
  isValidIban,
  normalizeIban,
  paymentDetailsInputSchema,
} from "./payment-details"
import { parseSellerSnapshot } from "./documents"

/** A valid Danish IBAN: DK, check digits 50, reg.nr. 0040, account number 0440116243. */
const DANISH_IBAN = "DK5000400440116243"

const EMPTY_BANK_ACCOUNT = {
  accountHolder: null,
  bankName: null,
  regNumber: null,
  accountNumber: null,
  iban: null,
  bic: null,
}

/** An IBAN with correct mod-97 check digits for any country and basic account number. */
function ibanWithCheckDigits(country: string, bban: string): string {
  const digits = (country + "00" + bban)
    .slice(4)
    .concat(country, "00")
    .replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55))
  let remainder = 0
  for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97
  return `${country}${String(98 - remainder).padStart(2, "0")}${bban}`
}

describe("IBAN validation", () => {
  it("accepts the Danish sample IBAN", () => {
    expect(isValidIban(DANISH_IBAN)).toBe(true)
  })

  it("rejects an IBAN with a corrupted digit", () => {
    expect(isValidIban("DK5000400440116244")).toBe(false)
    expect(isValidIban("DK5100400440116243")).toBe(false)
  })

  it.each([["DK0000400440116270"], ["DK0100400440116252"], ["DK9900400440116331"]])(
    "rejects %s: check digits 00, 01 and 99 are reserved even though mod-97 passes",
    (iban) => {
      // The numbers are built to pass the mod-97 check, so only the reserved range rejects them.
      const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55))
      let remainder = 0
      for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97
      expect(remainder).toBe(1)
      expect(isValidIban(iban)).toBe(false)
    }
  )

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

  it("checks the length of a known country's IBAN", () => {
    // Both have correct check digits, so only the length can reject the second one.
    const tooLong = ibanWithCheckDigits("DK", "0040044011624" + "30")
    expect(tooLong).toHaveLength(IBAN_LENGTH_BY_COUNTRY.DK! + 1)
    expect(isValidIban(ibanWithCheckDigits("DK", "004004401162" + "43"))).toBe(true)
    expect(isValidIban(tooLong)).toBe(false)
    expect(isValidIban(ibanWithCheckDigits("DK", "0040044011624"))).toBe(false)
  })

  it.each(Object.entries(IBAN_LENGTH_BY_COUNTRY))(
    "accepts a %s IBAN of %i characters and rejects one more or less",
    (country, length) => {
      const bban = "0".repeat(length - 4)
      expect(isValidIban(ibanWithCheckDigits(country, bban))).toBe(true)
      expect(isValidIban(ibanWithCheckDigits(country, `${bban}0`))).toBe(false)
      expect(isValidIban(ibanWithCheckDigits(country, bban.slice(1)))).toBe(false)
    }
  )

  it.each([
    ["AE07 0331 2345 6789 0123 456"],
    ["BR18 0036 0305 0000 1000 9795 493C 1"],
  ])("only applies the generic length range to an unlisted country: %s", (iban) => {
    expect(isValidIban(iban)).toBe(true)
  })

  it("normalizes and formats", () => {
    expect(normalizeIban(" dk50 0040 0440 1162 43 ")).toBe(DANISH_IBAN)
    expect(formatIban(DANISH_IBAN)).toBe("DK50 0040 0440 1162 43")
    expect(formatIban("dk50 0040 0440 1162 43")).toBe("DK50 0040 0440 1162 43")
  })
})

describe("BIC validation", () => {
  it.each([["DABADKKK"], ["DABADKKKXXX"], ["nykbdkkk"], ["DAB ADK KK"], ["1ABADKKK"], ["A1B2DKKK"]])("accepts %j", (bic) => {
    expect(isValidBic(bic)).toBe(true)
  })

  it.each([[""], ["DABADKK"], ["DABADKKKXX"], ["DABA1KKK"], ["DABADKKKXXXX"], ["DABA-DKKK"]])(
    "rejects %j",
    (bic) => {
      expect(isValidBic(bic)).toBe(false)
    }
  )
})

const FULL_ACCOUNT = {
  accountHolder: "Acme ApS",
  bankName: "Danske Bank",
  regNumber: "0040",
  accountNumber: "0440116243",
  iban: DANISH_IBAN,
  bic: "DABADKKK",
}

const issuePaths = (result: ReturnType<typeof bankAccountSchema.safeParse>) =>
  result.success ? [] : result.error.issues.map((issue) => issue.path.join("."))

describe("bank account", () => {
  it("accepts a complete account and normalizes it", () => {
    expect(
      bankAccountSchema.parse({
        accountHolder: "  Acme ApS ",
        bankName: "Danske Bank",
        regNumber: " 0040 ",
        accountNumber: "0440 116243",
        iban: "dk50 0040 0440 1162 43",
        bic: " dabadkkk ",
      })
    ).toEqual(FULL_ACCOUNT)
  })

  it("accepts an account with nothing in it", () => {
    expect(bankAccountSchema.parse({})).toEqual(EMPTY_BANK_ACCOUNT)
    expect(
      bankAccountSchema.parse({ accountHolder: "", bankName: "   ", regNumber: "", accountNumber: "", iban: " ", bic: "" })
    ).toEqual(EMPTY_BANK_ACCOUNT)
  })

  it("accepts an international-only setup without Danish account numbers", () => {
    expect(bankAccountSchema.parse({ iban: DANISH_IBAN, bic: "DABADKKK" })).toMatchObject({
      iban: DANISH_IBAN,
      regNumber: null,
      accountNumber: null,
    })
  })

  it("accepts a Danish-only setup without an IBAN", () => {
    expect(bankAccountSchema.parse({ regNumber: "0040", accountNumber: "0440116243" })).toMatchObject({
      iban: null,
      regNumber: "0040",
    })
  })

  it.each([["123"], ["12345"], ["12a4"], ["12-4"]])("rejects the reg.nr. %j", (regNumber) => {
    expect(issuePaths(bankAccountSchema.safeParse({ regNumber, accountNumber: "1234567" }))).toContain("regNumber")
  })

  it.each([["12345678901"], ["12a"], ["1/2"], ["0440116243-1"]])("rejects the account number %j", (accountNumber) => {
    expect(issuePaths(bankAccountSchema.safeParse({ regNumber: "0040", accountNumber }))).toContain("accountNumber")
  })

  it("strips spaces, dashes and dots from the reg.nr. and account number", () => {
    expect(bankAccountSchema.parse({ regNumber: "00-40", accountNumber: "0440.116-243" })).toMatchObject({
      regNumber: "0040",
      accountNumber: "0440116243",
    })
    expect(bankAccountSchema.parse({ regNumber: "0040", accountNumber: "0440 1162 43" }).accountNumber).toBe("0440116243")
  })

  it("accepts account numbers from one to ten digits", () => {
    expect(bankAccountSchema.safeParse({ regNumber: "0040", accountNumber: "1" }).success).toBe(true)
    expect(bankAccountSchema.safeParse({ regNumber: "0040", accountNumber: "1234567890" }).success).toBe(true)
  })

  it("requires the reg.nr. and account number together", () => {
    expect(issuePaths(bankAccountSchema.safeParse({ regNumber: "0040" }))).toEqual(["accountNumber"])
    expect(issuePaths(bankAccountSchema.safeParse({ accountNumber: "0440116243" }))).toEqual(["regNumber"])
    // A blank counterpart is the same as a missing one.
    expect(bankAccountSchema.safeParse({ regNumber: "0040", accountNumber: "  " }).success).toBe(false)
    // Together they are enough, even with an IBAN missing.
    expect(bankAccountSchema.safeParse({ regNumber: "0040", accountNumber: "0440116243" }).success).toBe(true)
  })

  it.each([
    ["a bank name", { bankName: "Danske Bank" }],
    ["an account holder", { accountHolder: "Acme ApS" }],
    ["a BIC", { bic: "DABADKKK" }],
    ["a holder, bank and BIC", { accountHolder: "Acme ApS", bankName: "Danske Bank", bic: "DABADKKK" }],
  ])("refuses %s without an IBAN or reg.nr. and account number", (_name, input) => {
    expect(issuePaths(bankAccountSchema.safeParse(input))).toEqual(["iban"])
  })

  it("accepts a bank name next to an IBAN, or next to a reg.nr. and account number", () => {
    expect(bankAccountSchema.safeParse({ bankName: "Danske Bank", iban: DANISH_IBAN }).success).toBe(true)
    expect(
      bankAccountSchema.safeParse({ bankName: "Danske Bank", regNumber: "0040", accountNumber: "0440116243" }).success
    ).toBe(true)
  })

  it("rejects a corrupted IBAN and a malformed BIC", () => {
    expect(issuePaths(bankAccountSchema.safeParse({ iban: "DK5000400440116244" }))).toEqual(["iban"])
    expect(issuePaths(bankAccountSchema.safeParse({ iban: DANISH_IBAN, bic: "DABADKK" }))).toEqual(["bic"])
  })

  describe("Danish IBAN cross-check", () => {
    it("accepts a DK IBAN that agrees with the reg.nr. and account number", () => {
      expect(bankAccountSchema.safeParse({ iban: DANISH_IBAN, regNumber: "0040", accountNumber: "0440116243" }).success).toBe(true)
    })

    it("compares the zero-padded account number", () => {
      const iban = ibanWithCheckDigits("DK", "00400000012345")
      expect(isValidIban(iban)).toBe(true)
      expect(bankAccountSchema.safeParse({ iban, regNumber: "0040", accountNumber: "12345" }).success).toBe(true)
    })

    it.each([
      ["the reg.nr.", { regNumber: "0041", accountNumber: "0440116243" }],
      ["the account number", { regNumber: "0040", accountNumber: "0440116244" }],
    ])("rejects a DK IBAN that disagrees on %s", (_name, numbers) => {
      const result = bankAccountSchema.safeParse({ iban: DANISH_IBAN, ...numbers })
      expect(issuePaths(result)).toEqual(["iban"])
      if (!result.success) expect(result.error.issues[0]?.message).toBe("The IBAN does not match the registration number and account number")
    })

    it("does not compare an IBAN from another country with the Danish numbers", () => {
      const iban = ibanWithCheckDigits("DE", "370400440532013000")
      expect(bankAccountSchema.safeParse({ iban, regNumber: "0040", accountNumber: "0440116243" }).success).toBe(true)
    })
  })

  it("limits the account holder and bank name", () => {
    expect(bankAccountSchema.safeParse({ iban: DANISH_IBAN, accountHolder: "x".repeat(121) }).success).toBe(false)
    expect(bankAccountSchema.safeParse({ iban: DANISH_IBAN, bankName: "x".repeat(121) }).success).toBe(false)
  })

  it("reports whether any account field is filled in", () => {
    expect(hasBankAccount(null)).toBe(false)
    expect(hasBankAccount(EMPTY_BANK_ACCOUNT)).toBe(false)
    expect(hasBankAccount({ bankName: "  " })).toBe(false)
    expect(hasBankAccount({ bankName: "Danske Bank" })).toBe(true)
  })
})

describe("payment details input", () => {
  it("takes an account and a note", () => {
    expect(
      paymentDetailsInputSchema.parse({ bankAccount: { ...FULL_ACCOUNT, iban: "dk50 0040 0440 1162 43" }, note: " MobilePay Box 12345 " })
    ).toEqual({ bankAccount: FULL_ACCOUNT, note: "MobilePay Box 12345" })
  })

  it("makes everything optional, and a blank account is no account", () => {
    expect(paymentDetailsInputSchema.parse({})).toEqual(EMPTY_PAYMENT_DETAILS)
    expect(paymentDetailsInputSchema.parse({ bankAccount: null, note: null })).toEqual(EMPTY_PAYMENT_DETAILS)
    expect(paymentDetailsInputSchema.parse({ bankAccount: {}, note: "  " })).toEqual(EMPTY_PAYMENT_DETAILS)
    expect(
      paymentDetailsInputSchema.parse({ bankAccount: { accountHolder: "", iban: " ", bic: "" }, note: "" })
    ).toEqual(EMPTY_PAYMENT_DETAILS)
  })

  it("accepts a note without an account", () => {
    expect(paymentDetailsInputSchema.parse({ note: "Pay by MobilePay" })).toEqual({
      bankAccount: null,
      note: "Pay by MobilePay",
    })
  })

  it("reports account problems under the account", () => {
    const result = paymentDetailsInputSchema.safeParse({ bankAccount: { regNumber: "0040" } })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toEqual([["bankAccount", "accountNumber"]])

    const bankNameOnly = paymentDetailsInputSchema.safeParse({ bankAccount: { bankName: "Danske Bank" } })
    expect(bankNameOnly.success).toBe(false)
    if (!bankNameOnly.success) expect(bankNameOnly.error.issues.map((issue) => issue.path)).toEqual([["bankAccount", "iban"]])
  })

  it("rejects a DK IBAN with one digit too many", () => {
    const result = paymentDetailsInputSchema.safeParse({ bankAccount: { iban: ibanWithCheckDigits("DK", "004004401162430") } })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["bankAccount", "iban"])
  })

  it("limits the payment note to 500 characters", () => {
    expect(paymentDetailsInputSchema.safeParse({ note: "x".repeat(500) }).success).toBe(true)
    const tooLong = paymentDetailsInputSchema.safeParse({ note: "x".repeat(501) })
    expect(tooLong.success).toBe(false)
    if (!tooLong.success) expect(tooLong.error.issues[0]?.path).toEqual(["note"])
  })

  it("reports whether there is anything to print", () => {
    expect(hasPaymentDetails(null)).toBe(false)
    expect(hasPaymentDetails(EMPTY_PAYMENT_DETAILS)).toBe(false)
    expect(hasPaymentDetails({ bankAccount: {}, note: "  " })).toBe(false)
    expect(hasPaymentDetails({ note: "MobilePay Box 12345" })).toBe(true)
    expect(hasPaymentDetails({ bankAccount: { iban: DANISH_IBAN } })).toBe(true)
  })
})

describe("seller snapshot payment details", () => {
  it("keeps parsing snapshots issued before payment details existed", () => {
    expect(parseSellerSnapshot({ companyName: "Acme", taxIds: [] })).toEqual({
      companyName: "Acme",
      taxIds: [],
    })
  })

  it("parses a frozen bank account and note", () => {
    const bankAccount = { iban: DANISH_IBAN, bic: "DABADKKK", regNumber: "0040", accountNumber: "0440116243" }
    const parsed = parseSellerSnapshot({ companyName: "Acme", bankAccount, paymentNote: "MobilePay Box 12345" })
    expect(parsed?.bankAccount).toEqual(bankAccount)
    expect(parsed?.paymentNote).toBe("MobilePay Box 12345")
    expect(parseSellerSnapshot({ companyName: "Acme", bankAccount: null, paymentNote: null })).toMatchObject({
      bankAccount: null,
      paymentNote: null,
    })
  })

  it("reads stored values leniently", () => {
    // Values were validated on the way in; an old snapshot is never re-validated.
    expect(parseSellerSnapshot({ bankAccount: { iban: "not an iban", regNumber: "12" } })?.bankAccount).toEqual({
      iban: "not an iban",
      regNumber: "12",
    })
  })
})
