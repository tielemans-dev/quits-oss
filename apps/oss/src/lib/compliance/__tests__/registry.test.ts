import { describe, expect, it } from "vitest"
import {
  findCountryInText,
  isNationalRegistrationScheme,
  isVatNumberScheme,
  resolveCountryProfile,
  taxIdSchemeOptions,
} from "../registry"

describe("resolveCountryProfile", () => {
  it("resolves a country module and its regime", () => {
    const profile = resolveCountryProfile(" dk ")
    expect(profile.countryCode).toBe("DK")
    expect(profile.country?.label).toBe("Denmark")
    expect(profile.regime?.id).toBe("eu_vat")
  })

  it("applies only the regime to a member country without a module", () => {
    const profile = resolveCountryProfile("PL")
    expect(profile.country).toBeNull()
    expect(profile.regime?.id).toBe("eu_vat")
  })

  it("leaves unknown countries unsupported instead of falling back to the US", () => {
    for (const code of ["GB", "ZZ"]) {
      const profile = resolveCountryProfile(code)
      expect(profile.country).toBeNull()
      expect(profile.regime).toBeNull()
    }
    expect(resolveCountryProfile(null).countryCode).toBeNull()
    expect(resolveCountryProfile("Denmark").countryCode).toBeNull()
  })
})

describe("tax-ID schemes", () => {
  it("treats a national registration as a VAT number only in its own country", () => {
    expect(isNationalRegistrationScheme("CVR", "DK")).toBe(true)
    expect(isNationalRegistrationScheme("dk_cvr", "DK")).toBe(true)
    expect(isNationalRegistrationScheme("cvr", "DE")).toBe(false)
  })

  it("recognizes VAT-number schemes across supported countries", () => {
    expect(isVatNumberScheme("VAT")).toBe(true)
    expect(isVatNumberScheme("cvr")).toBe(true)
    expect(isVatNumberScheme("DK_CVR")).toBe(true)
    expect(isVatNumberScheme("ein")).toBe(false)
    expect(isVatNumberScheme(undefined)).toBe(false)
  })

  it("offers the schemes of the country and its regime", () => {
    expect(taxIdSchemeOptions("DK").map((option) => option.value)).toEqual(["vat", "cvr"])
    expect(taxIdSchemeOptions("DE").map((option) => option.value)).toEqual(["vat"])
    expect(taxIdSchemeOptions("US").map((option) => option.value)).toEqual(["ein"])
    expect(taxIdSchemeOptions("GB").map((option) => option.value)).toEqual(["ein", "vat"])
  })
})

describe("findCountryInText", () => {
  it("finds the country named first", () => {
    expect(findCountryInText("We are a Danish studio billing in USD")?.countryCode).toBe("DK")
    expect(findCountryInText("Based in the Netherlands")?.countryCode).toBe("NL")
    expect(findCountryInText("No country here")).toBeNull()
  })
})
