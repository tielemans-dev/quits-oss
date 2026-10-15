import { describe, expect, it } from "vitest"
import {
  evaluateOnboardingReadiness,
  type OnboardingReadinessInput,
} from "../onboarding/readiness"

function buildInput(
  overrides: Partial<OnboardingReadinessInput> = {}
): OnboardingReadinessInput {
  return {
    countryCode: "US",
    invoicingIdentity: "registered_business",
    locale: "en-US",
    timezone: "UTC",
    defaultCurrency: "USD",
    taxRegime: "us_sales_tax",
    pricesIncludeTax: false,
    companyName: "Acme LLC",
    companyAddress: "Main St 1",
    companyEmail: "billing@acme.example",
    invoicePrefix: "INV",
    invoiceNextNum: 1,
    quotePrefix: "QTE",
    quoteNextNum: 1,
    primaryTaxId: null,
    ...overrides,
  }
}

describe("evaluateOnboardingReadiness", () => {
  it("returns missing required fields for incomplete data", () => {
    const result = evaluateOnboardingReadiness(
      buildInput({
        companyName: " ",
        companyAddress: null,
        companyEmail: "",
        locale: "",
        defaultCurrency: "  ",
        invoicePrefix: "",
        quotePrefix: "",
      })
    )

    expect(result.isComplete).toBe(false)
    expect(result.missing).toEqual(
      expect.arrayContaining([
        "companyName",
        "companyAddress",
        "companyEmail",
        "locale",
        "defaultCurrency",
        "invoicePrefix",
        "quotePrefix",
      ])
    )
  })

  it("requires primary tax id for eu vat organizations", () => {
    const result = evaluateOnboardingReadiness(
      buildInput({
        countryCode: "DK",
        invoicingIdentity: "registered_business",
        taxRegime: "eu_vat",
        primaryTaxId: " ",
      })
    )

    expect(result.isComplete).toBe(false)
    expect(result.missing).toContain("primaryTaxId")
  })

  it("does not require primary tax id when the tax field is hidden", () => {
    const result = evaluateOnboardingReadiness(
      buildInput({
        countryCode: "DK",
        invoicingIdentity: "individual",
        taxRegime: "eu_vat",
        primaryTaxId: " ",
      })
    )

    expect(result.isComplete).toBe(true)
    expect(result.missing).not.toContain("primaryTaxId")
  })

  it("marks onboarding complete when required values are present", () => {
    const result = evaluateOnboardingReadiness(
      buildInput({
        taxRegime: "eu_vat",
        primaryTaxId: "DK12345678",
      })
    )

    expect(result).toEqual({
      isComplete: true,
      missing: [],
    })
  })
})
