import { describe, expect, it } from "vitest"
import {
  currencyFractionDigits,
  fromStripeMinorUnits,
  isExactInCurrency,
  toStripeMinorUnits,
} from "../payments/stripe-amounts"

describe("stripe amounts", () => {
  it("converts two-decimal currencies through cents", () => {
    expect(toStripeMinorUnits(19.99, "USD")).toBe(1999)
    expect(toStripeMinorUnits(0.1 + 0.2, "eur")).toBe(30)
    expect(fromStripeMinorUnits(1999, "usd")).toBe(19.99)
  })

  it("keeps zero-decimal currencies in whole units", () => {
    expect(toStripeMinorUnits(500, "JPY")).toBe(500)
    expect(toStripeMinorUnits(15000, "krw")).toBe(15000)
    expect(fromStripeMinorUnits(500, "jpy")).toBe(500)
  })

  it("sends ISK and UGX as whole units with two zero decimals", () => {
    expect(toStripeMinorUnits(5, "ISK")).toBe(500)
    expect(fromStripeMinorUnits(500, "isk")).toBe(5)
  })

  it("sends three-decimal currencies in thousandths", () => {
    expect(toStripeMinorUnits(12.5, "KWD")).toBe(12_500)
    expect(fromStripeMinorUnits(12_500, "kwd")).toBe(12.5)
  })

  it("reports how many decimals a currency allows", () => {
    expect(currencyFractionDigits("JPY")).toBe(0)
    expect(currencyFractionDigits("isk")).toBe(0)
    expect(currencyFractionDigits("USD")).toBe(2)
    expect(currencyFractionDigits("KWD")).toBe(3)
  })

  it("never rounds an amount the currency cannot represent", () => {
    expect(isExactInCurrency(100.49, "JPY")).toBe(false)
    expect(isExactInCurrency(100.5, "jpy")).toBe(false)
    expect(isExactInCurrency(100, "JPY")).toBe(true)
    expect(isExactInCurrency(5.4, "ISK")).toBe(false)
    expect(isExactInCurrency(0.1 + 0.2, "EUR")).toBe(true)
    expect(isExactInCurrency(1.005, "EUR")).toBe(false)
    expect(() => toStripeMinorUnits(100.49, "JPY")).toThrow(RangeError)
    expect(() => toStripeMinorUnits(100.5, "JPY")).toThrow(RangeError)
    expect(() => toStripeMinorUnits(5.4, "ISK")).toThrow(RangeError)
  })
})
