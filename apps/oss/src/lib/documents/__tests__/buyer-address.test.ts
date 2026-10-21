import { describe, expect, it } from "vitest"
import { detailBuyerAddress } from "../buyer-address"

describe("detail buyer address", () => {
  const buyer = { name: "Test Buyer", address: "Testvej 2", city: "Aalborg", zip: "9000", country: "DK" }
  it.each(["da-DK", "en-US"])("orders Danish postal lines and omits domestic country in %s", locale => {
    expect(detailBuyerAddress(buyer, "DK", locale)).toEqual(["Testvej 2", "9000 Aalborg"])
  })
  it.each(["Denmark", "Danmark", " dk "])("recognizes supported free-text country %s", country => {
    expect(detailBuyerAddress({ ...buyer, country }, "DK", "da-DK")).toEqual(["Testvej 2", "9000 Aalborg"])
  })
  it("keeps a localized country for foreign buyers and the foreign postal order", () => {
    expect(detailBuyerAddress(buyer, "US", "en-US")).toEqual(["Testvej 2", "9000 Aalborg", "Denmark"])
    expect(detailBuyerAddress({ ...buyer, city: "Boston", state: "MA", zip: "02108", country: "US" }, "DK", "da-DK")).toEqual(["Testvej 2", "Boston, MA, 02108", "USA"])
  })
  it("shows the country when buyer and seller share a country other than Denmark", () => {
    expect(detailBuyerAddress({ ...buyer, city: "Boston", state: "MA", zip: "02108", country: "US" }, "US", "en-US")).toEqual(["Testvej 2", "Boston, MA, 02108", "United States"])
    expect(detailBuyerAddress({ ...buyer, city: "Stockholm", zip: "111 51", country: "SE" }, "SE", "da-DK")).toEqual(["Testvej 2", "Stockholm, 111 51", "Sverige"])
  })
  it("handles missing address fields", () => {
    expect(detailBuyerAddress({ name: "Test", country: null }, "DK", "da-DK")).toEqual([])
  })
  it.each(["da-DK", "en-US"])("preserves explicit unknown countries and foreign locality fields in %s", locale => {
    expect(detailBuyerAddress({ ...buyer, city: "Madrid", state: "Madrid", zip: "28001", country: "España" }, "DK", locale))
      .toEqual(["Testvej 2", "Madrid, Madrid, 28001", "España"])
  })
  it.each([null, undefined, "", "   "])("uses the seller's Danish order only for missing country %s", country => {
    expect(detailBuyerAddress({ ...buyer, country }, "DK", "en-US")).toEqual(["Testvej 2", "9000 Aalborg"])
  })
})
