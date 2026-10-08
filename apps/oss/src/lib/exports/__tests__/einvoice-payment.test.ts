import { describe, expect, it } from "vitest"
import { buildEinvoicePayment } from "../einvoice"

const FULL_ACCOUNT = {
  accountHolder: "Nordic Design ApS",
  bankName: "Danske Bank",
  regNumber: "0040",
  accountNumber: "0440116243",
  iban: "DK5000400440116243",
  bic: "DABADKKK",
}
const IBAN_ONLY = { iban: "DK5000400440116243" }
const DANISH_NUMBERS_ONLY = { regNumber: "0040", accountNumber: "0440116243" }

const pair = (sellerCountry: string | null, buyerCountry: string | null, currency = "DKK") => ({
  reference: "INV-0007",
  currency,
  sellerCountry,
  buyerCountry,
})
const DK_DK = (currency = "DKK") => pair("DK", "DK", currency)

describe("buildEinvoicePayment", () => {
  describe("Danish seller and Danish buyer", () => {
    it("prefers the reg.nr. and account number: code 42, account number as ID, reg.nr. as branch", () => {
      expect(buildEinvoicePayment(FULL_ACCOUNT, DK_DK())).toEqual({
        meansCode: "42",
        accountId: "0440116243",
        accountName: "Nordic Design ApS",
        branchId: "0040",
        reference: "INV-0007",
      })
    })

    it("uses the reg.nr. and account number also on a EUR invoice", () => {
      expect(buildEinvoicePayment(FULL_ACCOUNT, DK_DK("EUR"))).toMatchObject({
        meansCode: "42",
        accountId: "0440116243",
        branchId: "0040",
      })
    })

    it("sends a EUR invoice to an IBAN as SEPA (58), with the BIC as branch", () => {
      expect(buildEinvoicePayment({ ...IBAN_ONLY, bic: "DABADKKK" }, DK_DK("EUR"))).toEqual({
        meansCode: "58",
        accountId: "DK5000400440116243",
        accountName: null,
        branchId: "DABADKKK",
        reference: "INV-0007",
      })
    })

    it("sends a EUR invoice to an IBAN without a BIC as SEPA (58) without a branch", () => {
      expect(buildEinvoicePayment(IBAN_ONLY, DK_DK("EUR"))).toMatchObject({ meansCode: "58", branchId: null })
    })

    it("sends a non-EUR invoice to an IBAN and BIC as code 42 with the IBAN as ID and the BIC as branch (DK-R-006)", () => {
      expect(buildEinvoicePayment({ ...IBAN_ONLY, bic: "dabadkkk" }, DK_DK("SEK"))).toEqual({
        meansCode: "42",
        accountId: "DK5000400440116243",
        accountName: null,
        branchId: "DABADKKK",
        reference: "INV-0007",
      })
    })

    it("sends no payment means for a non-EUR invoice to an IBAN without a BIC: DK-R-006 could not be met", () => {
      expect(buildEinvoicePayment(IBAN_ONLY, DK_DK("DKK"))).toBeNull()
    })

    it("sends no payment means without an account", () => {
      expect(buildEinvoicePayment(null, DK_DK())).toBeNull()
      expect(buildEinvoicePayment({ bankName: "Danske Bank" }, DK_DK())).toBeNull()
    })

    it("does not use a reg.nr. without an account number", () => {
      expect(buildEinvoicePayment({ regNumber: "0040" }, DK_DK())).toBeNull()
    })
  })

  describe("any other pair of countries", () => {
    it.each([
      ["a Danish seller and a German buyer", "DK", "DE"],
      ["a German seller and a Danish buyer", "DE", "DK"],
      ["a Danish seller and a buyer without a country", "DK", null],
      ["a seller without a country", null, "DK"],
    ])("sends a EUR invoice to an IBAN as SEPA (58) for %s", (_name, sellerCountry, buyerCountry) => {
      expect(buildEinvoicePayment(FULL_ACCOUNT, pair(sellerCountry, buyerCountry, "EUR"))).toEqual({
        meansCode: "58",
        accountId: "DK5000400440116243",
        accountName: "Nordic Design ApS",
        branchId: "DABADKKK",
        reference: "INV-0007",
      })
    })

    it.each([["DKK"], ["SEK"], ["USD"], ["GBP"]])("sends a %s invoice to an IBAN as code 30", (currency) => {
      expect(buildEinvoicePayment(FULL_ACCOUNT, pair("DK", "DE", currency))).toMatchObject({
        meansCode: "30",
        accountId: "DK5000400440116243",
        branchId: "DABADKKK",
      })
    })

    it("sends no payment means to a foreign buyer when the account has only Danish numbers", () => {
      expect(buildEinvoicePayment(DANISH_NUMBERS_ONLY, pair("DK", "DE", "EUR"))).toBeNull()
      expect(buildEinvoicePayment(DANISH_NUMBERS_ONLY, pair("DK", "SE", "SEK"))).toBeNull()
    })

    it("falls back to the IBAN, not the Danish numbers, for a foreign buyer", () => {
      expect(buildEinvoicePayment(FULL_ACCOUNT, pair("DK", "SE", "SEK"))).toMatchObject({
        meansCode: "30",
        accountId: "DK5000400440116243",
      })
    })
  })

  it("treats the currency case-insensitively and keeps the given reference", () => {
    expect(buildEinvoicePayment(IBAN_ONLY, { ...pair("DK", "DE", "eur"), reference: "OCR-123" })).toMatchObject({
      meansCode: "58",
      reference: "OCR-123",
    })
  })

  it("leaves out a blank account holder", () => {
    expect(buildEinvoicePayment({ ...FULL_ACCOUNT, accountHolder: "  " }, DK_DK())?.accountName).toBeNull()
  })
})
