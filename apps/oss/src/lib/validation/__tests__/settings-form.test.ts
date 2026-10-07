import { describe, expect, it } from "vitest"
import { validateSettingsFormInput } from "../settings-form"

describe("validateSettingsFormInput", () => {
  it("accepts valid settings form values", () => {
    expect(
      validateSettingsFormInput({
        timezone: "Europe/Copenhagen",
        taxRateRaw: "25",
        companyEmail: "billing@example.com",
        companyPhone: "+45 12 34 56 78",
        invoicePrefix: "INV",
        quotePrefix: "QTE-2026",
      })
    ).toBeNull()
  })

  it("rejects invalid timezone", () => {
    expect(
      validateSettingsFormInput({
        timezone: "Mars/Olympus",
        taxRateRaw: "",
      })
    ).toBe("invalid_timezone")
  })

  it("rejects tax rate outside 0-100", () => {
    expect(
      validateSettingsFormInput({
        timezone: "UTC",
        taxRateRaw: "200",
      })
    ).toBe("invalid_tax_rate")
  })

  it("rejects invalid company email", () => {
    expect(
      validateSettingsFormInput({
        timezone: "UTC",
        taxRateRaw: "",
        companyEmail: "bad-email",
      })
    ).toBe("invalid_company_email")
  })

  it("rejects invalid company phone", () => {
    expect(
      validateSettingsFormInput({
        timezone: "UTC",
        taxRateRaw: "",
        companyPhone: "abc",
      })
    ).toBe("invalid_company_phone")
  })

  it("rejects invalid invoice/quote prefixes", () => {
    expect(
      validateSettingsFormInput({
        timezone: "UTC",
        taxRateRaw: "",
        invoicePrefix: "inv",
      })
    ).toBe("invalid_invoice_prefix")

    expect(
      validateSettingsFormInput({
        timezone: "UTC",
        taxRateRaw: "",
        quotePrefix: "quote-too-long",
      })
    ).toBe("invalid_quote_prefix")

    expect(
      validateSettingsFormInput({
        timezone: "UTC",
        taxRateRaw: "",
        creditNotePrefix: "cn",
      })
    ).toBe("invalid_credit_note_prefix")
  })
})
