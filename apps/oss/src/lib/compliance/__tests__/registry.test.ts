import { describe, expect, it } from "vitest"
import { countryOptionsIncluding } from "../countries"
import {
  countryLabel,
  findCountryInText,
  isCountryCode,
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

describe("country codes", () => {
  it("accepts every ISO country, supported or not, and nothing else", () => {
    expect(countryLabel("dk")).toBe("Denmark")
    expect(countryLabel("GB")).toBe("United Kingdom")
    expect(isCountryCode("XK")).toBe(true)
    // Intl names retired and reserved codes too; UK reaching an e-invoice would be wrong (GB).
    for (const code of ["ZZ", "EU", "UN", "QO", "XX", "UK", "YU", "AN", "EA", "Denmark", "", null]) {
      expect(isCountryCode(code)).toBe(false)
    }
  })

  it("keeps an unsupported current country among the options", () => {
    const supported = countryOptionsIncluding(null).map((option) => option.code)
    expect(supported).toEqual(["US", "DK", "DE", "FR", "NL"])
    expect(countryOptionsIncluding("DK").map((option) => option.code)).toEqual(supported)
    expect(countryOptionsIncluding("gb").at(-1)).toEqual({ code: "GB", label: "United Kingdom" })
    expect(countryOptionsIncluding("ZZ").map((option) => option.code)).toEqual(supported)
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

  it("puts the selected regime's schemes first", () => {
    expect(taxIdSchemeOptions("US", "eu_vat").map((option) => option.value)).toEqual(["vat", "ein"])
    expect(taxIdSchemeOptions("DK", "eu_vat").map((option) => option.value)).toEqual(["vat", "cvr"])
    expect(taxIdSchemeOptions("DK", "custom").map((option) => option.value)).toEqual(["vat", "cvr"])
  })
})

describe("findCountryInText", () => {
  it("finds the country named first", () => {
    expect(findCountryInText("We are a Danish studio billing in USD")?.countryCode).toBe("DK")
    expect(findCountryInText("Based in the Netherlands")?.countryCode).toBe("NL")
    expect(findCountryInText("No country here")).toBeNull()
  })
})
