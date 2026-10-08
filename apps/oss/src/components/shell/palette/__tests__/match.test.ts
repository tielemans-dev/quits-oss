import { describe, expect, it } from "vitest"

import { matchItems } from "../match"

const items = [
  { label: "Fakturaer", keywords: ["invoices"] },
  { label: "Gentagne fakturaer" },
  { label: "Kreditnotaer", keywords: ["credit notes"] },
]

describe("matchItems", () => {
  it("keeps everything and its order for an empty query", () => {
    expect(matchItems(items, "  ")).toEqual(items)
  })

  it("needs every word, ignoring case and accents, in the label or the keywords", () => {
    expect(matchItems(items, "kredit").map((item) => item.label)).toEqual(["Kreditnotaer"])
    expect(matchItems(items, "credit notes").map((item) => item.label)).toEqual(["Kreditnotaer"])
    expect(matchItems(items, "Fakturæ").map((item) => item.label)).toEqual([])
  })

  it("puts labels that start with the query first", () => {
    expect(matchItems(items, "fakt").map((item) => item.label)).toEqual(["Fakturaer", "Gentagne fakturaer"])
    expect(matchItems(items, "aer").map((item) => item.label)).toEqual([
      "Fakturaer",
      "Gentagne fakturaer",
      "Kreditnotaer",
    ])
  })
})
