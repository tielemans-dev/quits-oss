import { describe, expect, it } from "vitest"
import { parseBuyerSnapshot, parseSellerSnapshot } from "./documents"

describe("document snapshots", () => {
  it("parses stored seller snapshots", () => {
    expect(
      parseSellerSnapshot({
        companyName: "Acme",
        companyEmail: null,
        taxIds: [{ scheme: "vat", value: "DK123", countryCode: null }],
      })
    ).toEqual({
      companyName: "Acme",
      companyEmail: null,
      taxIds: [{ scheme: "vat", value: "DK123", countryCode: null }],
    })
  })

  it("returns null for missing or malformed snapshots", () => {
    expect(parseSellerSnapshot(null)).toBeNull()
    expect(parseBuyerSnapshot("not an object")).toBeNull()
    expect(parseBuyerSnapshot({ name: 42 })).toBeNull()
  })
})
