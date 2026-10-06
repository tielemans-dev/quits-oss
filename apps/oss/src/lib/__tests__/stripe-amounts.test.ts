import { describe, expect, it } from "vitest"
import { fromStripeMinorUnits, toStripeMinorUnits } from "../payments/stripe-amounts"

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
    expect(toStripeMinorUnits(5.4, "isk")).toBe(500)
    expect(fromStripeMinorUnits(500, "isk")).toBe(5)
  })
})
