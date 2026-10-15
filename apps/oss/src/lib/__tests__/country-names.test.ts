import { describe, expect, it } from "vitest"
import { countryName, ISO_COUNTRY_CODES } from "../country-names"
import { buyerAddress } from "../documents/invoice-identity"

describe("customer country labels", () => {
  it("is the canonical country set: the 249 ISO countries plus Kosovo, without grouping codes", () => {
    expect(ISO_COUNTRY_CODES).toHaveLength(250)
    expect(new Set(ISO_COUNTRY_CODES).size).toBe(250)
    expect(ISO_COUNTRY_CODES).toContain("XK")
    expect(ISO_COUNTRY_CODES).not.toContain("EU")
    expect(countryName("XK", "en-US")).toBe("Kosovo")
  })
  it.each([["Sweden", "Sverige"], ["Sverige", "Sverige"], ["Germany", "Tyskland"], ["Tyskland", "Tyskland"], ["se", "Sverige"]])("prints the legacy name %s in the document language", (value, expected) => {
    expect(countryName(value, "da-DK")).toBe(expected)
  })
  it.each(["DK", "dk", "Danmark", "Denmark"])("prints %s in the document language", value => {
    expect(countryName(value, "da-DK")).toBe("Danmark")
    expect(countryName(value, "en-US")).toBe("Denmark")
  })
  it("keeps unknown historical values visible", () => expect(countryName("Synthetic unknown", "da-DK")).toBe("Synthetic unknown"))
  it("localizes the country in the email's buyer address", () => {
    expect(buyerAddress({ address: "Testvej 1", zip: "1000", city: "København", country: "DK" }, "da-DK")).toEqual(["Testvej 1", "1000 København", "Danmark"])
  })
})
