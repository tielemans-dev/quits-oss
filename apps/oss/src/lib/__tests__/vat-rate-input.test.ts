import { describe, expect, it } from "vitest"
import { vatFractionToPercentText, vatPercentTextToFraction } from "../vat-rate-input"

describe("VAT rate entered as a percentage", () => {
  it.each([["25", "0.25"], ["12,5", "0.125"], ["12.5", "0.125"], [" 0 ", "0"], ["12,", "0.12"], ["100", "1"]])("stores %s %% as %s", (typed, fraction) => {
    expect(vatPercentTextToFraction(typed)).toBe(fraction)
  })

  it.each(["", "abc", "-5", "1,2,3", "25%"])("rejects %j", (typed) => {
    expect(vatPercentTextToFraction(typed)).toBeNull()
  })

  it.each([["0.25", "da-DK", "25"], ["0.125", "da-DK", "12,5"], ["0.125", "en-US", "12.5"], ["0", "da-DK", "0"]])("shows %s as %s in %s", (fraction, locale, text) => {
    expect(vatFractionToPercentText(fraction, locale)).toBe(text)
  })

  it("keeps text that is not a stored rate", () => {
    expect(vatFractionToPercentText("", "da-DK")).toBe("")
    expect(vatFractionToPercentText("abc", "da-DK")).toBe("abc")
  })

  it("round-trips the shown percentage to the same fraction", () => {
    for (const fraction of ["0.25", "0.125", "0.06", "0"]) expect(vatPercentTextToFraction(vatFractionToPercentText(fraction, "da-DK"))).toBe(fraction)
  })
})
