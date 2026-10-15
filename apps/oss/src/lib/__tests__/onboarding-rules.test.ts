import { describe, expect, it } from "vitest"
import { getOnboardingRules } from "../onboarding/rules"

describe("getOnboardingRules", () => {
  it("defaults an absent jurisdiction to Denmark", () => {
    expect(getOnboardingRules({}).defaults).toMatchObject({ defaultCurrency: "DKK", taxRegime: "eu_vat" })
  })
  it("suggests danish defaults for registered businesses in denmark", () => {
    const rules = getOnboardingRules({
      countryCode: "DK",
      invoicingIdentity: "registered_business",
      taxRegime: null,
    })

    expect(rules.defaults).toEqual({
      locale: "da-DK",
      timezone: "Europe/Copenhagen",
      defaultCurrency: "DKK",
      taxRegime: "eu_vat",
      pricesIncludeTax: false,
    })
    expect(rules.showPrimaryTaxId).toBe(true)
    expect(rules.requirePrimaryTaxId).toBe(true)
  })

  it("keeps danish defaults but hides tax id for individuals in denmark", () => {
    const rules = getOnboardingRules({
      countryCode: "DK",
      invoicingIdentity: "individual",
      taxRegime: null,
    })

    expect(rules.defaults).toEqual({
      locale: "da-DK",
      timezone: "Europe/Copenhagen",
      defaultCurrency: "DKK",
      taxRegime: "custom",
      pricesIncludeTax: false,
    })
    expect(rules.showPrimaryTaxId).toBe(false)
    expect(rules.requirePrimaryTaxId).toBe(false)
  })

  it("suggests us defaults for united states onboarding", () => {
    const rules = getOnboardingRules({
      countryCode: "US",
      invoicingIdentity: "registered_business",
      taxRegime: null,
    })

    expect(rules.defaults).toEqual({
      locale: "en-US",
      timezone: "America/New_York",
      defaultCurrency: "USD",
      taxRegime: "us_sales_tax",
      pricesIncludeTax: false,
    })
    expect(rules.showPrimaryTaxId).toBe(false)
    expect(rules.requirePrimaryTaxId).toBe(false)
  })

  it("requires a primary tax id only when visible eu vat business rules apply", () => {
    expect(
      getOnboardingRules({
        countryCode: "DE",
        invoicingIdentity: "registered_business",
        taxRegime: "eu_vat",
      }).requirePrimaryTaxId
    ).toBe(true)

    expect(
      getOnboardingRules({
        countryCode: "DE",
        invoicingIdentity: "individual",
        taxRegime: "eu_vat",
      }).requirePrimaryTaxId
    ).toBe(false)
  })
})
